const assert = require("node:assert/strict");
const { test } = require("node:test");
const express = require("express");
const OfficialGeminiGateway = require("../src/core/OfficialGeminiGateway");
const FormatConverter = require("../src/core/FormatConverter");

const logger = { debug() {}, error() {}, getLevel: () => "INFO", info() {}, warn() {} };
const response = {
    candidates: [{ content: { parts: [{ text: "API_OK" }], role: "model" }, finishReason: "STOP", index: 0 }],
    modelVersion: "gemini-test",
    usageMetadata: { candidatesTokenCount: 2, promptTokenCount: 1, totalTokenCount: 3 },
};

async function fixture(run, options = {}) {
    const requests = [];
    const buildRequests = [];
    const completedRequests = [];
    const state = { accountId: "oauth-id", mode: "oauth", projectId: "test-cloud-project" };
    const target = { accountId: "oauth-id", mode: "oauth", projectId: "test-cloud-project" };
    const account = { email: "test@example.com", id: "oauth-id", identityVerified: true, needsOAuthClient: false };
    const system = {
        config: {
            fakeStreamTimeoutMs: 1000,
            maxRetries: 3,
            retryDelay: 1,
            safetySettingsThreshold: "OFF",
            streamingMode: "real",
            streamTimeoutMs: 1000,
        },
        logger,
        oauthAccountStore: { listAccounts: async () => [account] },
        upstreamChannelStore: {
            get: async () => ({ ...state }),
            getOAuthTarget: async () => ({ ...target }),
        },
    };
    const transport = {
        dispatch: async (request, channel, emit, signal) => {
            requests.push({ channel: { ...channel }, request: { ...request } });
            assert.equal(signal.aborted, false);
            const ids = { request_attempt_id: request.request_attempt_id, request_id: request.request_id };
            if (request.body?.includes("SIMULATE_QUOTA_ERROR")) {
                emit({ ...ids, event_type: "error", message: "upstream_quota_exhausted", status: 429 });
                return;
            }
            emit({
                ...ids,
                event_type: "response_headers",
                headers: {
                    "content-type": request.path.includes("streamGenerateContent")
                        ? "text/event-stream"
                        : "application/json",
                },
                status: 200,
            });
            const payload =
                request.method === "GET"
                    ? { models: [{ inputTokenLimit: 1000, name: "models/gemini-test", outputTokenLimit: 100 }] }
                    : response;
            const data = request.path.includes("streamGenerateContent")
                ? `data: ${JSON.stringify(payload)}\n\n`
                : JSON.stringify(payload);
            emit({ ...ids, data, event_type: "chunk" });
            emit({ ...ids, event_type: "stream_close" });
        },
    };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        if (options.authenticate && req.headers.authorization !== "Bearer accepted-key") return res.sendStatus(401);
        res.on("finish", () =>
            completedRequests.push({
                originalUrl: req.originalUrl,
                request_original_url: req.request_original_url,
                url: req.url,
            })
        );
        next();
    });
    app.use(new OfficialGeminiGateway(system, { transport }).middleware());
    app.use((req, res) => {
        buildRequests.push({
            originalUrl: req.originalUrl,
            path: req.path,
            request_original_url: req.request_original_url,
            url: req.url,
        });
        res.json({ build: true });
    });
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    try {
        await run({
            account,
            base: `http://127.0.0.1:${server.address().port}`,
            buildRequests,
            completedRequests,
            requests,
            state,
            system,
            target,
        });
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}

test("OAuth transport shares conversion and response handling for all four API formats", async () => {
    await fixture(async ({ base, requests }) => {
        const cases = [
            [
                "/v1/chat/completions",
                { messages: [{ content: "hello", role: "user" }], model: "gemini-test", stream: false },
                body => body.choices[0].message.content,
            ],
            [
                "/v1/responses",
                { input: "hello", model: "gemini-test", stream: false },
                body => body.output.find(item => item.type === "message").content[0].text,
            ],
            [
                "/v1/messages",
                { max_tokens: 16, messages: [{ content: "hello", role: "user" }], model: "gemini-test", stream: false },
                body => body.content.find(item => item.type === "text").text,
            ],
            [
                "/v1beta/models/gemini-test:generateContent",
                { contents: [{ parts: [{ text: "hello" }], role: "user" }] },
                body => body.candidates[0].content.parts[0].text,
            ],
        ];
        for (const [url, payload, content] of cases) {
            const result = await fetch(base + url, {
                body: JSON.stringify(payload),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });
            assert.equal(result.status, 200, url);
            assert.equal(result.headers.get("x-aistudio-upstream"), "google-oauth");
            assert.equal(content(await result.json()), "API_OK", url);
        }
        assert.equal(requests.length, 4);
        for (const { channel, request } of requests) {
            assert.equal(channel.accountId, "oauth-id");
            assert.equal(channel.projectId, "test-cloud-project");
            assert.equal(request.path, "/v1beta/models/gemini-test:generateContent");
            assert.ok(JSON.parse(request.body).contents.length);
        }
    });
});

test("explicit OAuth namespace and original Build endpoints work simultaneously without changing the default", async () => {
    await fixture(async ({ base, buildRequests, completedRequests, requests, state }) => {
        state.mode = "build";
        const old = await fetch(base + "/v1/chat/completions?trace=old", {
            body: JSON.stringify({ messages: [{ content: "hello", role: "user" }], model: "gemini-test" }),
            headers: { "Content-Type": "application/json", "X-AIStudio-Channel": "oauth" },
            method: "POST",
        });
        assert.deepEqual(await old.json(), { build: true });
        assert.equal(old.headers.get("x-aistudio-upstream"), "aistudio-build");
        assert.equal(requests.length, 0);

        const official = await fetch(base + "/oauth/v1/chat/completions?trace=official", {
            body: JSON.stringify({ messages: [{ content: "hello", role: "user" }], model: "gemini-test" }),
            headers: {
                "Content-Type": "application/json",
                "X-AIStudio-Channel": "build",
                "x-goog-user-project": "wrong-project",
            },
            method: "POST",
        });
        assert.equal(official.status, 200);
        assert.equal((await official.json()).choices[0].message.content, "API_OK");
        assert.equal(official.headers.get("x-aistudio-upstream"), "google-oauth");
        assert.equal(requests.length, 1);
        assert.equal(requests[0].channel.projectId, "test-cloud-project");
        assert.equal(state.mode, "build");
        assert.equal(buildRequests.length, 1);
        const preserved = completedRequests.find(item => item.originalUrl.startsWith("/oauth/"));
        assert.equal(preserved.originalUrl, "/oauth/v1/chat/completions?trace=official");
        assert.equal(preserved.request_original_url, preserved.originalUrl);
        assert.equal(preserved.url, "/v1/chat/completions?trace=official");
    });
});

test("namespace matching respects segment boundaries and handles prefix case, trailing slashes and model formats", async () => {
    await fixture(async ({ base, buildRequests, requests, state }) => {
        state.mode = "build";
        for (const url of ["/oauthish/v1/models", "/buildish/v1/models", "/oauth%2Fv1/models"]) {
            assert.deepEqual(await (await fetch(base + url)).json(), { build: true });
            assert.equal(buildRequests.at(-1).url, url);
        }
        assert.equal(requests.length, 0);
        const openaiModels = await fetch(base + "/OaUtH/v1/models/?pageSize=10");
        assert.equal(openaiModels.status, 200);
        assert.equal((await openaiModels.json()).data[0].id, "gemini-test");
        const geminiModels = await fetch(base + "/oauth/v1beta/models/");
        assert.equal((await geminiModels.json()).models[0].name, "models/gemini-test");
        assert.equal(requests.length, 2);
        assert.ok(requests.every(item => item.request.path === "/v1beta/models"));
        assert.deepEqual(requests[0].request.query_params, { pageSize: "10" });
    });
});

test("explicit Build namespace bypasses an OAuth default or broken channel configuration while preserving the original URL", async () => {
    await fixture(async ({ base, buildRequests, requests, system }) => {
        system.upstreamChannelStore.get = async () => {
            throw new Error("configuration unavailable");
        };
        system.upstreamChannelStore.getOAuthTarget = async () => {
            throw new Error("must not inspect OAuth target");
        };
        const result = await fetch(base + "/BuIlD/v1/models/?trace=forced");
        assert.deepEqual(await result.json(), { build: true });
        assert.equal(result.headers.get("x-aistudio-upstream"), "aistudio-build");
        assert.equal(requests.length, 0);
        assert.equal(buildRequests[0].url, "/v1/models/?trace=forced");
        assert.equal(buildRequests[0].originalUrl, "/BuIlD/v1/models/?trace=forced");
        assert.equal(buildRequests[0].request_original_url, buildRequests[0].originalUrl);
    });
});

test("explicit OAuth errors and unsupported VNC/uploads cannot reach Build or retry paid requests", async () => {
    await fixture(async ({ base, buildRequests, requests, state, system }) => {
        state.mode = "build";
        const failed = await fetch(base + "/oauth/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "SIMULATE_QUOTA_ERROR", role: "user" }],
                model: "gemini-test",
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        assert.equal(failed.status, 429);
        assert.equal(requests.length, 1);
        assert.equal((await fetch(base + "/oauth/vnc")).status, 501);
        assert.equal((await fetch(base + "/oauth/upload/v1beta/files", { method: "POST" })).status, 501);
        assert.equal(requests.length, 1);
        system.upstreamChannelStore.getOAuthTarget = async () => {
            throw Object.assign(new Error("not configured"), {
                code: "official_channel_not_configured",
                statusCode: 503,
            });
        };
        assert.equal((await fetch(base + "/oauth/v1/models")).status, 503);
        assert.equal(requests.length, 1);
        assert.equal(buildRequests.length, 0);
        assert.equal(state.mode, "build");
    });
});

test("authentication is checked before either explicit namespace is selected", async () => {
    await fixture(
        async ({ base, buildRequests, requests, state }) => {
            state.mode = "build";
            for (const path of ["/v1/models", "/oauth/v1/models", "/build/v1/models"]) {
                assert.equal((await fetch(base + path)).status, 401);
                assert.equal(
                    (await fetch(base + path, { headers: { Authorization: "Bearer incorrect-key" } })).status,
                    401
                );
            }
            assert.equal(buildRequests.length, 0);
            assert.equal(requests.length, 0);
            assert.equal(
                (await fetch(base + "/oauth/v1/models", { headers: { Authorization: "Bearer accepted-key" } })).status,
                200
            );
            assert.equal(requests.length, 1);
        },
        { authenticate: true }
    );
});

test("disconnecting during account lookup cannot start paid inference after lookup completes", async () => {
    await fixture(async ({ account, base, requests, state, system }) => {
        state.mode = "build";
        let release;
        let entered;
        const enteredLookup = new Promise(resolve => {
            entered = resolve;
        });
        const lookup = new Promise(resolve => {
            release = resolve;
        });
        system.oauthAccountStore.listAccounts = async () => {
            entered();
            await lookup;
            return [account];
        };
        const controller = new AbortController();
        const pending = fetch(base + "/oauth/v1/chat/completions", {
            body: JSON.stringify({ messages: [{ content: "hello", role: "user" }], model: "gemini-test" }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
            signal: controller.signal,
        }).catch(error => error.name);
        await enteredLookup;
        controller.abort();
        await pending;
        await new Promise(resolve => setTimeout(resolve, 20));
        release();
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(requests.length, 0);
    });
});

test("disconnecting during asynchronous protocol conversion cannot start paid inference afterwards", async () => {
    const original = FormatConverter.prototype.translateOpenAIToGoogle;
    let release;
    let entered;
    const enteredConversion = new Promise(resolve => {
        entered = resolve;
    });
    const conversion = new Promise(resolve => {
        release = resolve;
    });
    FormatConverter.prototype.translateOpenAIToGoogle = async function (...args) {
        entered();
        await conversion;
        return original.apply(this, args);
    };
    try {
        await fixture(async ({ base, requests, state }) => {
            state.mode = "build";
            const controller = new AbortController();
            const pending = fetch(base + "/oauth/v1/chat/completions", {
                body: JSON.stringify({ messages: [{ content: "hello", role: "user" }], model: "gemini-test" }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
                signal: controller.signal,
            }).catch(error => error.name);
            await enteredConversion;
            controller.abort();
            await pending;
            await new Promise(resolve => setTimeout(resolve, 20));
            release();
            await new Promise(resolve => setTimeout(resolve, 20));
            assert.equal(requests.length, 0);
        });
    } finally {
        release();
        FormatConverter.prototype.translateOpenAIToGoogle = original;
    }
});

test("OAuth streaming, official model catalog and upstream errors never fall back or retry paid generation", async () => {
    await fixture(async ({ base, requests, state, account }) => {
        const models = await fetch(base + "/v1/models");
        assert.equal((await models.json()).data[0].id, "gemini-test");
        const streamed = await fetch(base + "/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "hello", role: "user" }],
                model: "gemini-test",
                stream: true,
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        assert.equal(streamed.status, 200);
        const chunks = await streamed.text();
        assert.ok(chunks.includes("API_OK"));
        assert.ok(chunks.includes("[DONE]"));
        const before = requests.length;
        const failed = await fetch(base + "/v1/chat/completions", {
            body: JSON.stringify({
                messages: [{ content: "SIMULATE_QUOTA_ERROR", role: "user" }],
                model: "gemini-test",
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        assert.equal(failed.status, 429);
        assert.equal(requests.length, before + 1);
        state.accountId = "deleted-account";
        assert.equal((await fetch(base + "/v1/models")).status, 503);
        state.accountId = account.id;
        account.needsOAuthClient = true;
        assert.equal((await fetch(base + "/v1/models")).status, 503);
        state.mode = "build";
        assert.deepEqual(await (await fetch(base + "/v1/models")).json(), { build: true });
    });
});

test("Responses, Claude and native Gemini streaming use the same official transport", async () => {
    await fixture(async ({ base, requests }) => {
        const cases = [
            ["/v1/responses", { input: "hello", model: "gemini-test", stream: true }, "response.output_text.delta"],
            [
                "/v1/messages",
                { max_tokens: 16, messages: [{ content: "hello", role: "user" }], model: "gemini-test", stream: true },
                "content_block_delta",
            ],
            [
                "/v1beta/models/gemini-test:streamGenerateContent?alt=sse",
                { contents: [{ parts: [{ text: "hello" }], role: "user" }] },
                "data:",
            ],
        ];
        for (const [url, payload, event] of cases) {
            const result = await fetch(base + url, {
                body: JSON.stringify(payload),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });
            assert.equal(result.status, 200, url);
            const body = await result.text();
            assert.ok(body.includes("API_OK"), url);
            assert.ok(body.includes(event), url);
        }
        assert.equal(requests.length, 3);
        assert.ok(requests.every(item => item.request.path.endsWith(":streamGenerateContent")));
    });
});
