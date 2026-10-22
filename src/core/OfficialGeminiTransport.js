const axios = require("axios");
const { TextDecoder } = require("util");

const ORIGIN = "https://generativelanguage.googleapis.com";
const MODEL_PATH =
    /^\/(v1|v1beta)\/models(?:\/([A-Za-z0-9][A-Za-z0-9._-]{0,199})(?::(generateContent|streamGenerateContent|countTokens|embedContent|batchEmbedContents))?)?$/;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

class TransportError extends Error {
    constructor(code, status = 400) {
        super(code);
        this.code = code;
        this.status = status;
    }
}

function abortable(start, signal) {
    if (signal.aborted) return Promise.reject(new TransportError("request_aborted", 499));
    return new Promise((resolve, reject) => {
        const abort = () => reject(new TransportError("request_aborted", 499));
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve()
            .then(() => {
                if (signal.aborted) throw new TransportError("request_aborted", 499);
                return start();
            })
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
    });
}

function prepareRequest(proxyRequest, projectId) {
    if (typeof projectId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,149}$/.test(projectId)) {
        throw new TransportError("cloud_project_required");
    }
    if (!proxyRequest || typeof proxyRequest.path !== "string" || proxyRequest.url) {
        throw new TransportError("unsupported_official_endpoint");
    }
    const method = String(proxyRequest.method || "GET").toUpperCase();
    const match = proxyRequest.path.match(MODEL_PATH);
    if (!match || !["GET", "POST"].includes(method)) throw new TransportError("unsupported_official_endpoint");
    const action = match[3];
    if ((method === "POST" && !action) || (method === "GET" && action)) {
        throw new TransportError("unsupported_official_endpoint");
    }
    if (proxyRequest.body_b64 || proxyRequest.isBodyBase64) throw new TransportError("json_body_required");
    let requestPath = proxyRequest.path;
    const isRealStream = action === "streamGenerateContent" && proxyRequest.streaming_mode !== "fake";
    if (action === "streamGenerateContent" && !isRealStream) {
        requestPath = requestPath.replace(/:streamGenerateContent$/, ":generateContent");
    }
    const url = new URL(requestPath, ORIGIN);
    if (isRealStream) url.searchParams.set("alt", "sse");
    // All client authentication, billing overrides and proxy host parameters are discarded.
    if (method === "GET" && !match[2]) {
        const query = proxyRequest.query_params || {};
        if (Number.isInteger(Number(query.pageSize)) && Number(query.pageSize) > 0 && Number(query.pageSize) <= 1000) {
            url.searchParams.set("pageSize", String(query.pageSize));
        }
        if (typeof query.pageToken === "string" && query.pageToken.length <= 4096) {
            url.searchParams.set("pageToken", query.pageToken);
        }
    }
    let body;
    if (method === "POST") {
        if (typeof proxyRequest.body !== "string" || Buffer.byteLength(proxyRequest.body, "utf8") > MAX_BODY_BYTES) {
            throw new TransportError("json_body_required");
        }
        try {
            const parsed = JSON.parse(proxyRequest.body);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_body");
        } catch {
            throw new TransportError("json_body_required");
        }
        body = proxyRequest.body;
    }
    return { body, isRealStream, method, url: url.href };
}

class OfficialGeminiTransport {
    constructor(oauthStore, options = {}) {
        this.oauthStore = oauthStore;
        this.httpClient = options.httpClient || axios;
        this.timeoutMs = Math.min(Math.max(options.timeoutMs || 300000, 1), 300000);
    }

    async dispatch(proxyRequest, channel, emit, signal) {
        const controller = new AbortController();
        let timedOut = false;
        let responseStream;
        const cancel = () => controller.abort();
        const stopStream = () => responseStream?.destroy?.();
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, this.timeoutMs);
        if (signal?.aborted) controller.abort();
        signal?.addEventListener("abort", cancel, { once: true });
        controller.signal.addEventListener("abort", stopStream);
        const publish = event =>
            emit({
                ...event,
                request_attempt_id: proxyRequest?.request_attempt_id,
                request_id: proxyRequest?.request_id,
            });
        try {
            if (controller.signal.aborted) throw new TransportError("request_aborted", 499);
            const prepared = prepareRequest(proxyRequest, channel?.projectId);
            if (!channel?.accountId || typeof channel.accountId !== "string") {
                throw new TransportError("oauth_account_required");
            }
            const token = await abortable(() => this.oauthStore.getAccessToken(channel.accountId), controller.signal);
            if (typeof token.accessToken !== "string" || !token.accessToken || /[\r\n]/.test(token.accessToken)) {
                throw new TransportError("oauth_credentials_unavailable", 503);
            }
            if (controller.signal.aborted) throw new TransportError("request_aborted", 499);
            const response = await abortable(
                () =>
                    this.httpClient
                        .request({
                            data: prepared.body,
                            headers: {
                                Accept: prepared.isRealStream ? "text/event-stream" : "application/json",
                                Authorization: `Bearer ${token.accessToken}`,
                                "Content-Type": "application/json",
                                "x-goog-user-project": channel.projectId,
                            },
                            maxBodyLength: MAX_BODY_BYTES,
                            maxContentLength: MAX_RESPONSE_BYTES,
                            maxRedirects: 0,
                            method: prepared.method,
                            responseType: "stream",
                            signal: controller.signal,
                            timeout: this.timeoutMs,
                            url: prepared.url,
                            validateStatus: () => true,
                        })
                        .then(result => {
                            if (controller.signal.aborted) {
                                result.data?.destroy?.();
                                throw new TransportError("request_aborted", 499);
                            }
                            return result;
                        }),
                controller.signal
            );
            responseStream = response.data;
            if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
                const status =
                    Number.isInteger(response.status) && response.status >= 300 && response.status <= 599
                        ? response.status
                        : 502;
                throw new TransportError("official_google_error", status);
            }
            publish({
                event_type: "response_headers",
                headers: {
                    "cache-control": "no-store",
                    "content-type": prepared.isRealStream
                        ? "text/event-stream; charset=utf-8"
                        : "application/json; charset=utf-8",
                },
                status: response.status,
            });
            const decoder = new TextDecoder("utf-8", { fatal: true });
            const chunks = [];
            let receivedBytes = 0;
            for await (const chunk of responseStream) {
                if (controller.signal.aborted) throw new TransportError("request_aborted", 499);
                const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
                receivedBytes += bytes.byteLength;
                if (receivedBytes > MAX_RESPONSE_BYTES) throw new TransportError("official_response_too_large", 502);
                const data = decoder.decode(bytes, { stream: true });
                if (prepared.isRealStream && data) publish({ data, event_type: "chunk" });
                else if (data) chunks.push(data);
            }
            if (controller.signal.aborted) throw new TransportError("request_aborted", 499);
            const remainder = decoder.decode();
            if (prepared.isRealStream) {
                if (remainder) publish({ data: remainder, event_type: "chunk" });
            } else {
                if (remainder) chunks.push(remainder);
                const data = chunks.join("");
                if (data) publish({ data, event_type: "chunk" });
            }
            publish({ event_type: "stream_close" });
        } catch (error) {
            let status = 502;
            let code = "official_transport_failed";
            let message = "Official Gemini API request failed. Check the OAuth account and configured Cloud project.";
            if (controller.signal.aborted) {
                status = timedOut ? 504 : 499;
                code = timedOut ? "official_request_timeout" : "request_aborted";
                message = timedOut ? "Official Gemini API request timed out." : "The user aborted a request";
            } else if (error instanceof TransportError) {
                status = error.status;
                code = error.code;
                message =
                    code === "official_google_error"
                        ? `Official Gemini API returned HTTP ${status}. Check project access, API permissions, quota and billing.`
                        : "Official Gemini API request is unavailable for this endpoint or channel configuration.";
            } else if (["ECONNABORTED", "ETIMEDOUT"].includes(error.code)) {
                status = 504;
                code = "official_request_timeout";
                message = "Official Gemini API request timed out.";
            } else if (Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) {
                status = error.statusCode;
                code = "oauth_credentials_unavailable";
            }
            publish({ code, event_type: "error", message, status });
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", cancel);
            controller.signal.removeEventListener("abort", stopStream);
            responseStream?.destroy?.();
        }
    }
}

module.exports = OfficialGeminiTransport;
