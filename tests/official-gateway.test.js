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

async function fixture(run) {
    const requests = [];
    const state = { accountId: "oauth-id", mode: "oauth", projectId: "test-cloud-project" };
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
        upstreamChannelStore: { get: async () => ({ ...state }) },
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
    app.use(new OfficialGeminiGateway(system, { transport }).middleware());
    app.use((req, res) => res.json({ build: true }));
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    try {
        await run({ account, base: `http://127.0.0.1:${server.address().port}`, requests, state, system });
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

test("disconnecting during account lookup cannot start paid inference after lookup completes", async () => {
    await fixture(async ({ account, base, requests, system }) => {
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
        const pending = fetch(base + "/v1/chat/completions", {
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
        await fixture(async ({ base, requests }) => {
            const controller = new AbortController();
            const pending = fetch(base + "/v1/chat/completions", {
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
