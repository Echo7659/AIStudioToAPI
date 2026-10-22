const crypto = require("crypto");
const ConnectionRegistry = require("./ConnectionRegistry");
const RequestHandler = require("./RequestHandler");
const OfficialGeminiTransport = require("./OfficialGeminiTransport");

const HANDLERS = new Map([
    ["/v1/chat/completions", "processOpenAIRequest"],
    ["/v1/responses", "processOpenAIResponseRequest"],
    ["/v1/responses/input_tokens", "processOpenAIResponseInputTokens"],
    ["/responses/input_tokens", "processOpenAIResponseInputTokens"],
    ["/v1/messages", "processClaudeRequest"],
    ["/v1/messages/count_tokens", "processClaudeCountTokens"],
    ["/v1/embeddings", "processOpenAIEmbeddingsRequest"],
    ["/v1/openai/embeddings", "processOpenAIEmbeddingsRequest"],
]);

class OfficialGeminiGateway {
    constructor(serverSystem, options = {}) {
        this.serverSystem = serverSystem;
        this.transport = options.transport || new OfficialGeminiTransport(serverSystem.oauthAccountStore);
    }

    middleware() {
        return async (req, res, next) => {
            try {
                const channel = await this.serverSystem.upstreamChannelStore.get();
                if (req.aborted || res.destroyed || res.writableEnded) return;
                if (channel.mode === "build") return next();
                if (req.method === "GET" && req.path.toLowerCase() === "/vnc") return next();
                if (/^\/(?:proxy\/)?upload\//i.test(req.path)) {
                    return this._error(res, 501, "official_file_upload_not_supported");
                }
                const accounts = await this.serverSystem.oauthAccountStore.listAccounts();
                if (req.aborted || res.destroyed || res.writableEnded) return;
                const account = accounts.find(item => item.id === channel.accountId);
                if (!account) return this._error(res, 503, "oauth_account_not_found");
                if (account.needsOAuthClient) return this._error(res, 503, "oauth_client_required");
                res.set("X-AIStudio-Upstream", "google-oauth");
                if (
                    req.method === "GET" &&
                    ["/v1/models", "/v1beta/models", "/v1alpha/models"].includes(
                        req.path.toLowerCase().replace(/\/$/, "")
                    )
                ) {
                    return await this._models(req, res, channel);
                }
                return await this._forward(req, res, channel, account);
            } catch (error) {
                if (!res.headersSent)
                    return this._error(res, error.statusCode || 503, error.code || "official_channel_unavailable");
                if (!res.writableEnded) res.end();
            }
        };
    }

    _error(res, status, code) {
        return res.status(status).json({ error: { code, message: code, type: "upstream_error" } });
    }

    async _models(req, res, channel) {
        const controller = new AbortController();
        const cancel = () => {
            if (!res.writableEnded) controller.abort();
        };
        res.on("close", cancel);
        let body = "";
        let error;
        let status = 200;
        try {
            await this.transport.dispatch(
                {
                    method: "GET",
                    path: "/v1beta/models",
                    query_params: req.query,
                    request_attempt_id: "models",
                    request_id: crypto.randomUUID(),
                },
                channel,
                event => {
                    if (event.event_type === "error") error = event;
                    if (event.event_type === "response_headers") status = event.status;
                    if (event.event_type === "chunk") {
                        body += event.data;
                        if (body.length > 2 * 1024 * 1024) {
                            error = { message: "model_list_too_large", status: 502 };
                            controller.abort();
                        }
                    }
                },
                controller.signal
            );
            if (res.destroyed || res.writableEnded) return;
            if (error) return this._error(res, error.status || 502, error.message || "model_list_unavailable");
            const payload = JSON.parse(body);
            if (req.path.toLowerCase().replace(/\/$/, "") !== "/v1/models") return res.status(status).json(payload);
            if (!Array.isArray(payload.models)) return this._error(res, 502, "invalid_model_list");
            return res.json({
                data: payload.models.map(model => ({
                    context_window: model.inputTokenLimit,
                    created: 0,
                    id: String(model.name).replace(/^models\//, ""),
                    max_tokens: model.outputTokenLimit,
                    object: "model",
                    owned_by: "google",
                })),
                ...(payload.nextPageToken ? { next_page_token: payload.nextPageToken } : {}),
                object: "list",
            });
        } finally {
            controller.abort();
            res.removeListener("close", cancel);
        }
    }

    async _forward(req, res, channel, account) {
        const registry = new ConnectionRegistry(this.serverSystem.logger);
        const controllers = new Map();
        let clientClosed = Boolean(req.aborted || res.destroyed || res.writableEnded);
        const cancelAll = () => {
            clientClosed = true;
            for (const controller of controllers.values()) controller.abort();
        };
        const connection = {
            readyState: 1,
            send: raw => {
                const request = JSON.parse(raw);
                const attemptId = request.request_attempt_id;
                if (request.event_type === "cancel_request") {
                    controllers.get(attemptId)?.abort();
                    return;
                }
                if (request.event_type !== "proxy_request") return;
                const emit = event => {
                    if (registry.messageQueues.has(request.request_id)) {
                        registry._handleIncomingMessage(JSON.stringify(event), 0);
                    }
                };
                if (clientClosed || req.aborted || res.destroyed || res.writableEnded) {
                    emit({
                        event_type: "error",
                        message: "The user aborted a request",
                        request_attempt_id: attemptId,
                        request_id: request.request_id,
                        status: 499,
                    });
                    return;
                }
                const controller = new AbortController();
                controllers.set(attemptId, controller);
                this.transport
                    .dispatch(request, channel, emit, controller.signal)
                    .catch(error => {
                        emit({
                            event_type: "error",
                            message: error.code || "official_request_failed",
                            request_attempt_id: attemptId,
                            request_id: request.request_id,
                            status: error.statusCode || 502,
                        });
                    })
                    .finally(() => {
                        if (controllers.get(attemptId) === controller) controllers.delete(attemptId);
                    });
            },
        };
        registry.connectionsByAuth.set(0, connection);
        const source = {
            accountNameMap: new Map([[0, `Google API · ${account.email || account.id}`]]),
            getCanonicalIndex: () => 0,
            getRotationIndices: () => [0],
        };
        const browser = { currentAuthIndex: 0, notifyUserActivity() {} };
        // Each HTTP request has its own queue and selection. Paid requests are
        // never retried on another account or silently sent through Build.
        const config = {
            ...this.serverSystem.config,
            failureThreshold: 0,
            immediateSwitchStatusCodes: [],
            maxRetries: 1,
            switchOnUses: 0,
        };
        const handler = new RequestHandler(
            this.serverSystem,
            registry,
            this.serverSystem.logger,
            browser,
            config,
            source
        );
        const routePath = req.path.toLowerCase().replace(/\/$/, "");
        const method = req.method === "POST" ? HANDLERS.get(routePath) || "processRequest" : "processRequest";
        res.on("close", cancelAll);
        try {
            await handler[method](req, res);
        } finally {
            cancelAll();
            registry.closeAllMessageQueues();
            registry.connectionsByAuth.clear();
            res.removeListener("close", cancelAll);
        }
    }
}

module.exports = OfficialGeminiGateway;
