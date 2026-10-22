const assert = require("node:assert/strict");
const { PassThrough, Readable } = require("node:stream");
const test = require("node:test");
const OfficialGeminiTransport = require("../src/core/OfficialGeminiTransport");

const channel = { accountId: "oauth-account", projectId: "explicit-billing-project" };
const request = overrides => ({
    body: JSON.stringify({ contents: [{ parts: [{ text: "Short reply" }], role: "user" }] }),
    headers: { "Content-Type": "application/json" },
    is_generative: true,
    method: "POST",
    path: "/v1beta/models/gemini-flash-lite-latest:generateContent",
    query_params: {},
    request_attempt_id: "request_attempt_1",
    request_id: "request_1",
    streaming_mode: "fake",
    ...overrides,
});

function fixture(responder, options = {}) {
    const calls = [];
    const tokenCalls = [];
    const store = {
        async getAccessToken(id) {
            tokenCalls.push(id);
            return { accessToken: "private-oauth-access-token" };
        },
    };
    const client = {
        async request(config) {
            calls.push(config);
            return responder(config);
        },
    };
    return {
        calls,
        store,
        tokenCalls,
        transport: new OfficialGeminiTransport(store, { httpClient: client, ...options }),
    };
}

test("uses fixed Google endpoint and selected billing project, discarding all client credentials and host overrides", async () => {
    const body = JSON.stringify({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
    const { calls, tokenCalls, transport } = fixture(() => ({ data: Readable.from([body]), status: 200 }));
    const events = [];
    await transport.dispatch(
        request({
            headers: {
                authorization: "Bearer client-secret",
                cookie: "GoogleCookie=browser-secret",
                host: "attacker.invalid",
                "x-api-key": "api-secret",
                "x-goog-api-key": "google-key-secret",
                "x-goog-user-project": "unapproved-project",
            },
            query_params: { __proxy_host__: "attacker.invalid", access_token: "query-secret", key: "key-secret" },
        }),
        channel,
        event => events.push(event)
    );
    assert.deepEqual(tokenCalls, ["oauth-account"]);
    assert.equal(calls.length, 1);
    assert.equal(
        calls[0].url,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent"
    );
    assert.deepEqual(calls[0].headers, {
        Accept: "application/json",
        Authorization: "Bearer private-oauth-access-token",
        "Content-Type": "application/json",
        "x-goog-user-project": "explicit-billing-project",
    });
    assert.equal(calls[0].maxRedirects, 0);
    assert.equal(calls[0].responseType, "stream");
    assert.deepEqual(
        events.map(event => event.event_type),
        ["response_headers", "chunk", "stream_close"]
    );
    assert.equal(events[1].data, body);
    assert.equal(
        events.every(event => event.request_id === "request_1" && event.request_attempt_id === "request_attempt_1"),
        true
    );
    for (const secret of [
        "client-secret",
        "browser-secret",
        "api-secret",
        "query-secret",
        "private-oauth-access-token",
    ]) {
        assert.equal(JSON.stringify(events).includes(secret), false);
    }
});

test("SSE streaming preserves UTF-8 characters split across network buffers", async () => {
    const body = Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"你好"}]}}]}\n\n');
    const split = body.indexOf(Buffer.from("你")) + 1;
    const { calls, transport } = fixture(() => ({
        data: Readable.from([body.subarray(0, split), body.subarray(split)]),
        status: 200,
    }));
    const events = [];
    await transport.dispatch(
        request({
            path: "/v1beta/models/gemini-flash-lite-latest:streamGenerateContent",
            streaming_mode: "real",
        }),
        channel,
        event => events.push(event)
    );
    assert.equal(new URL(calls[0].url).searchParams.get("alt"), "sse");
    assert.equal(calls[0].headers.Accept, "text/event-stream");
    const combined = events
        .filter(event => event.event_type === "chunk")
        .map(event => event.data)
        .join("");
    assert.equal(combined, body.toString("utf8"));
    assert.equal(combined.includes("�"), false);
    assert.equal(events.at(-1).event_type, "stream_close");
});

test("fake streaming uses a single generateContent request and one complete JSON chunk", async () => {
    const { calls, transport } = fixture(() => ({ data: Readable.from(['{"candidates":', "[]}"]), status: 200 }));
    const events = [];
    await transport.dispatch(
        request({
            path: "/v1beta/models/gemini-flash-lite-latest:streamGenerateContent",
            query_params: { alt: "sse" },
            streaming_mode: "fake",
        }),
        channel,
        event => events.push(event)
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.endsWith(":generateContent"), true);
    assert.equal(events.filter(event => event.event_type === "chunk").length, 1);
    assert.equal(events[1].data, '{"candidates":[]}');
});

test("rejects absolute URLs, path traversal, uploads, unsupported actions and missing project before token access", async () => {
    const { calls, tokenCalls, transport } = fixture(() => {
        throw new Error("must not send");
    });
    const attempts = [
        request({ path: "https://attacker.invalid/v1beta/models/model:generateContent" }),
        request({ path: "/v1beta/models/../files" }),
        request({ path: "/v1beta/models/model%2Fother:generateContent" }),
        request({ path: "/upload/v1beta/files" }),
        request({ path: "/v1beta/models/model:delete" }),
        request({ method: "GET" }),
        request({ url: "https://attacker.invalid" }),
        request({ body_b64: "aW52YWxpZA==" }),
        request({ body: "not JSON" }),
    ];
    for (const attempted of attempts) {
        const events = [];
        await transport.dispatch(attempted, channel, event => events.push(event));
        assert.equal(events.length, 1);
        assert.equal(events[0].event_type, "error");
        assert.equal(events[0].status, 400);
    }
    const events = [];
    await transport.dispatch(request(), { accountId: "oauth-account", projectId: "bad\r\nHost: attacker" }, event =>
        events.push(event)
    );
    assert.equal(events[0].code, "cloud_project_required");
    assert.equal(calls.length, 0);
    assert.equal(tokenCalls.length, 0);
});

test("preserves Google error HTTP status without exposing body credentials, following redirects or retrying", async () => {
    for (const status of [302, 401, 403, 429, 503]) {
        const stream = Readable.from(['{"error":{"message":"private-oauth-access-token GoogleCookie=secret"}}']);
        const { calls, transport } = fixture(() => ({ data: stream, status }));
        const events = [];
        await transport.dispatch(request(), channel, event => events.push(event));
        assert.equal(calls.length, 1);
        assert.equal(events.length, 1);
        assert.equal(events[0].status, status);
        assert.equal(events[0].code, "official_google_error");
        assert.equal(JSON.stringify(events).includes("private-oauth-access-token"), false);
        assert.equal(JSON.stringify(events).includes("GoogleCookie"), false);
        assert.equal(stream.destroyed, true);
    }
});

test("cancels an in-progress SSE stream and emits no stream completion after abort", async () => {
    const stream = new PassThrough();
    const controller = new AbortController();
    const { transport } = fixture(() => ({ data: stream, status: 200 }));
    const events = [];
    await transport.dispatch(
        request({
            path: "/v1beta/models/model:streamGenerateContent",
            streaming_mode: "real",
        }),
        channel,
        event => {
            events.push(event);
            if (event.event_type === "response_headers") controller.abort();
        },
        controller.signal
    );
    assert.equal(stream.destroyed, true);
    assert.equal(events.at(-1).event_type, "error");
    assert.equal(events.at(-1).status, 499);
    assert.equal(
        events.some(event => event.event_type === "stream_close"),
        false
    );
});

test("already aborted requests do not acquire tokens or contact Google", async () => {
    const { calls, tokenCalls, transport } = fixture(() => {
        throw new Error("must not send");
    });
    const controller = new AbortController();
    controller.abort();
    const events = [];
    await transport.dispatch(request(), channel, event => events.push(event), controller.signal);
    assert.equal(events[0].status, 499);
    assert.equal(calls.length, 0);
    assert.equal(tokenCalls.length, 0);
});

test("pre-abort never starts a rejecting token factory and pending token rejection after cancellation is consumed", async () => {
    const unhandled = [];
    const onUnhandled = error => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
        let tokenCalls = 0;
        const alreadyAborted = new AbortController();
        alreadyAborted.abort();
        const preAbortedTransport = new OfficialGeminiTransport({
            async getAccessToken() {
                tokenCalls++;
                throw new Error("private-token-failure");
            },
        });
        await preAbortedTransport.dispatch(request(), channel, () => {}, alreadyAborted.signal);
        assert.equal(tokenCalls, 0);

        let rejectToken;
        let started;
        const entered = new Promise(resolve => {
            started = resolve;
        });
        const pending = new Promise((resolve, reject) => {
            rejectToken = reject;
        });
        const transport = new OfficialGeminiTransport({
            getAccessToken() {
                started();
                return pending;
            },
        });
        const controller = new AbortController();
        const events = [];
        const running = transport.dispatch(request(), channel, event => events.push(event), controller.signal);
        await entered;
        controller.abort();
        await running;
        rejectToken(new Error("private-token-failure-after-cancel"));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(events.at(-1).status, 499);
        assert.deepEqual(unhandled, []);
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
});

test("total timeout aborts a stalled response stream without retry", async () => {
    const stream = new PassThrough();
    const { calls, transport } = fixture(() => ({ data: stream, status: 200 }), { timeoutMs: 20 });
    const events = [];
    await transport.dispatch(request(), channel, event => events.push(event));
    assert.equal(events.at(-1).status, 504);
    assert.equal(events.at(-1).code, "official_request_timeout");
    assert.equal(calls.length, 1);
    assert.equal(stream.destroyed, true);
});

test("documented model discovery, token counting and embedding routes remain available", async () => {
    const { calls, transport } = fixture(() => ({ data: Readable.from(["{}"]), status: 200 }));
    for (const action of ["countTokens", "embedContent", "batchEmbedContents"]) {
        const events = [];
        await transport.dispatch(request({ path: `/v1beta/models/gemini-model:${action}` }), channel, event =>
            events.push(event)
        );
        assert.equal(events.at(-1).event_type, "stream_close");
    }
    const events = [];
    await transport.dispatch(
        request({
            body: undefined,
            method: "GET",
            path: "/v1/models",
            query_params: {
                key: "discarded-secret",
                pageSize: "20",
                pageToken: "next-page",
                userProject: "wrong-project",
            },
        }),
        channel,
        event => events.push(event)
    );
    const url = new URL(calls.at(-1).url);
    assert.equal(url.searchParams.get("pageSize"), "20");
    assert.equal(url.searchParams.get("pageToken"), "next-page");
    assert.equal(url.searchParams.has("key"), false);
    assert.equal(url.searchParams.has("userProject"), false);
    assert.equal(events.at(-1).event_type, "stream_close");
});

test("sanitizes thrown HTTP client errors and credential errors", async () => {
    const { transport } = fixture(() => {
        throw new Error("private-oauth-access-token in request headers");
    });
    const events = [];
    await transport.dispatch(request(), channel, event => events.push(event));
    assert.equal(events[0].status, 502);
    assert.equal(JSON.stringify(events).includes("private-oauth-access-token"), false);
});
