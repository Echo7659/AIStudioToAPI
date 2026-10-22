const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const express = require("express");
const OAuthAccountStore = require("../src/auth/OAuthAccountStore");
const OAuthAccountRoutes = require("../src/routes/OAuthAccountRoutes");

async function fixture(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aistudio-oauth-test-"));
    t.after(() => fs.rm(directory, { force: true, recursive: true }));
    const filePath = path.join(directory, "auth", "oauth-accounts.json");
    return { filePath, store: new OAuthAccountStore({ env: {}, filePath, ...options }) };
}

function googleClient(overrides = {}) {
    const calls = [];
    return {
        calls,
        async get(url, options) {
            calls.push({ method: "get", options, url });
            if (overrides.get) return overrides.get(url, options);
            return {
                data: { email: "owner@example.com", email_verified: true, sub: "google-subject" },
                status: 200,
            };
        },
        async post(url, data, options) {
            calls.push({ data, method: "post", options, url });
            if (overrides.post) return overrides.post(url, data, options);
            return { data: { access_token: "temporary-access-secret", token_type: "Bearer" }, status: 200 };
        },
    };
}

test("imports supported OAuth formats into private sidecar and returns only public metadata", async t => {
    const { filePath, store } = await fixture(t);
    const first = await store.importAccounts(
        JSON.stringify({
            account: "OWNER@example.com",
            client_id: "original-client",
            client_secret: "client-secret",
            id_token: "discarded-id-token",
            refresh_token: "refresh-one",
            token: "discarded-access-token",
            token_uri: "https://oauth2.googleapis.com/token",
            type: "authorized_user",
        })
    );
    const second = await store.importAccounts({
        accounts: [
            { email: "second@example.com", refresh_token: "refresh-two" },
            {
                email: "third@example.com",
                token: {
                    access_token: "discarded-antigravity-access",
                    clientId: "nested-client",
                    clientSecret: "nested-secret",
                    oauth_client_key: "antigravity",
                    project_id: "example-project",
                    refresh_token: "refresh-three",
                },
            },
        ],
    });
    const third = await store.importAccounts([{ email: "fourth@example.com", refreshToken: "refresh-four" }]);
    assert.equal(first.successCount + second.successCount + third.successCount, 4);
    const accounts = await store.listAccounts();
    assert.equal(accounts[0].email, "owner@example.com");
    assert.equal(accounts[1].needsOAuthClient, true);
    assert.equal(accounts[2].projectId, "example-project");
    assert.equal(accounts[2].identityVerified, false);
    assert.deepEqual(Object.keys(accounts[0]).sort(), [
        "email",
        "errorCode",
        "id",
        "identityVerified",
        "lastVerifiedAt",
        "needsOAuthClient",
        "projectId",
    ]);
    const publicJson = JSON.stringify({ accounts, first, second, third });
    for (const secret of ["refresh-one", "refresh-two", "client-secret", "nested-secret"]) {
        assert.equal(publicJson.includes(secret), false);
    }
    const privateJson = await fs.readFile(filePath, "utf8");
    assert.equal(privateJson.includes("discarded-"), false);
    assert.equal(JSON.parse(privateJson).accounts[2].clientAlias, "antigravity");
    assert.deepEqual(await fs.readdir(path.dirname(filePath)), ["oauth-accounts.json"]);
    if (process.platform !== "win32") assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
});

test("rejects malformed imports, browser credentials, service accounts and external token endpoints", async t => {
    const { store } = await fixture(t);
    await assert.rejects(store.importAccounts("https://example.com/accounts.json"), { code: "invalid_json" });
    await assert.rejects(store.importAccounts({ accounts: {} }), { code: "invalid_accounts_array" });
    await assert.rejects(store.importAccounts([]), { code: "empty_import" });
    await assert.rejects(store.importAccounts(Array.from({ length: 1001 }, () => ({ refresh_token: "opaque" }))), {
        code: "too_many_accounts",
    });
    const imported = await store.importAccounts([
        { cookies: [], origins: [], refresh_token: "opaque" },
        { refresh_token: "opaque", token_uri: "https://attacker.invalid/token" },
        { refresh_token: "opaque", type: "service_account" },
        { email: "not-an-email", refresh_token: "opaque" },
        { email: "owner@example.com" },
    ]);
    assert.equal(imported.successCount, 0);
    assert.deepEqual(
        imported.results.map(result => result.code),
        [
            "browser_auth_requires_browser_import",
            "unsupported_token_endpoint",
            "unsupported_credential_type",
            "invalid_email",
            "missing_refresh_token",
        ]
    );
    assert.deepEqual(await store.listAccounts(), []);
});

test("serializes concurrent imports and preserves every unique allocation", async t => {
    const { filePath, store } = await fixture(t);
    const results = await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
            store.importAccounts({ email: `owner${index}@example.com`, refresh_token: `opaque-${index}` })
        )
    );
    assert.equal(
        results.every(result => result.successCount === 1),
        true
    );
    const accounts = await store.listAccounts();
    assert.equal(accounts.length, 20);
    assert.equal(new Set(accounts.map(account => account.id)).size, 20);
    assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).accounts.length, 20);
    assert.deepEqual(await fs.readdir(path.dirname(filePath)), ["oauth-accounts.json"]);
});

test("deduplicates identical credentials without overwriting a conflicting declared identity", async t => {
    const { store } = await fixture(t);
    const initial = await store.importAccounts({ email: "owner@example.com", refresh_token: "opaque" });
    const duplicate = await store.importAccounts({ email: "OWNER@example.com", refresh_token: "opaque" });
    assert.equal(initial.results[0].account.id, duplicate.results[0].account.id);
    const conflict = await store.importAccounts({ email: "other@example.com", refresh_token: "opaque" });
    assert.equal(conflict.results[0].code, "credential_identity_conflict");
    assert.equal((await store.listAccounts()).length, 1);
});

test("credential replacement reuses the account ID and resets previously verified identity", async t => {
    const client = googleClient();
    const { filePath, store } = await fixture(t, { httpClient: client });
    const imported = await store.importAccounts({
        client_id: "original-client",
        client_secret: "original-secret",
        email: "owner@example.com",
        refresh_token: "original-refresh",
    });
    const id = imported.results[0].account.id;
    await store.verifyAccount(id);
    const unchanged = await store.importAccounts({ email: "OWNER@example.com", refresh_token: "original-refresh" });
    assert.equal(unchanged.results[0].account.id, id);
    assert.equal(unchanged.results[0].account.identityVerified, true);

    const replaced = await store.importAccounts({
        clientId: "replacement-client",
        clientSecret: "replacement-secret",
        email: "owner@example.com",
        refreshToken: "replacement-refresh",
    });
    const account = replaced.results[0].account;
    assert.equal(account.id, id);
    assert.equal(account.identityVerified, false);
    assert.equal(account.lastVerifiedAt, null);
    assert.equal(account.errorCode, null);
    assert.equal((await store.listAccounts()).length, 1);
    const saved = JSON.parse(await fs.readFile(filePath, "utf8")).accounts[0];
    assert.equal(saved.subject, null);
    assert.equal(saved.refreshToken, "replacement-refresh");
    assert.equal(saved.clientId, "replacement-client");
    assert.equal(saved.clientSecret, "replacement-secret");
});

test("bounds object payload bytes as well as JSON string payload bytes", async t => {
    const { store } = await fixture(t);
    const input = { padding: "x".repeat(5 * 1024 * 1024), refresh_token: "opaque" };
    await assert.rejects(store.importAccounts(input), { code: "import_too_large" });
    await assert.rejects(store.importAccounts(JSON.stringify(input)), { code: "import_too_large" });
    assert.deepEqual(await store.listAccounts(), []);
});

test("missing client remains imported but verify performs no network request", async t => {
    const client = googleClient();
    const { store } = await fixture(t, { httpClient: client });
    const imported = await store.importAccounts({ email: "owner@example.com", refresh_token: "opaque" });
    const { id } = imported.results[0].account;
    await assert.rejects(store.verifyAccount(id), error => {
        assert.equal(error.code, "oauth_client_required");
        assert.equal(error.account.needsOAuthClient, true);
        return true;
    });
    assert.equal(client.calls.length, 0);
    assert.equal((await store.listAccounts())[0].identityVerified, false);
});

test("verifies identity through fixed Google endpoints using original client without scope escalation", async t => {
    const client = googleClient();
    const { filePath, store } = await fixture(t, {
        env: { GOOGLE_OAUTH_CLIENT_ID: "different-client", GOOGLE_OAUTH_CLIENT_SECRET: "different-secret" },
        httpClient: client,
    });
    const imported = await store.importAccounts({
        client_id: "original-client",
        client_secret: "original-secret",
        email: "owner@example.com",
        refresh_token: "original-refresh",
        scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
    const account = await store.verifyAccount(imported.results[0].account.id);
    assert.equal(account.identityVerified, true);
    assert.equal(account.needsOAuthClient, false);
    assert.equal(account.errorCode, null);
    assert.ok(account.lastVerifiedAt);
    assert.equal(client.calls[0].url, "https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(client.calls[0].data);
    assert.equal(form.get("client_id"), "original-client");
    assert.equal(form.get("client_secret"), "original-secret");
    assert.equal(form.get("grant_type"), "refresh_token");
    assert.equal(form.has("scope"), false);
    assert.equal(client.calls[0].options.maxRedirects, 0);
    assert.ok(client.calls[0].options.timeout <= 30000);
    assert.equal(client.calls[1].url, "https://openidconnect.googleapis.com/v1/userinfo");
    assert.equal(client.calls[1].options.headers.Authorization, "Bearer temporary-access-secret");
    const privateJson = await fs.readFile(filePath, "utf8");
    assert.equal(privateJson.includes("temporary-access-secret"), false);
    assert.equal(JSON.parse(privateJson).accounts[0].subject, "google-subject");
});

test("uses an explicitly configured fallback client and pins its ID after verification", async t => {
    const client = googleClient();
    const { filePath, store } = await fixture(t, {
        env: { GOOGLE_OAUTH_CLIENT_ID: "configured-client", GOOGLE_OAUTH_CLIENT_SECRET: "configured-secret" },
        httpClient: client,
    });
    const imported = await store.importAccounts({ refresh_token: "opaque" });
    const account = await store.verifyAccount(imported.results[0].account.id);
    assert.equal(account.email, "owner@example.com");
    const state = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.equal(state.accounts[0].clientId, "configured-client");
    assert.equal(state.accounts[0].clientSecret, null);
    assert.equal(new URLSearchParams(client.calls[0].data).get("client_secret"), "configured-secret");
});

test("rejects verified identity mismatch without replacing the declared account", async t => {
    const client = googleClient({
        get: () => ({
            data: { email: "different@example.com", email_verified: true, sub: "different-subject" },
            status: 200,
        }),
    });
    const { filePath, store } = await fixture(t, { httpClient: client });
    const imported = await store.importAccounts({
        client_id: "original-client",
        email: "owner@example.com",
        refresh_token: "opaque",
    });
    await assert.rejects(store.verifyAccount(imported.results[0].account.id), { code: "identity_mismatch" });
    const account = (await store.listAccounts())[0];
    assert.equal(account.email, "owner@example.com");
    assert.equal(account.identityVerified, false);
    assert.equal(account.errorCode, "identity_mismatch");
    assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).accounts[0].subject, null);
});

test("unverified email and insufficient identity scope cannot establish verified identity", async t => {
    for (const response of [
        { data: { email: "owner@example.com", email_verified: false, sub: "subject" }, status: 200 },
        { data: { email_verified: true, sub: "subject" }, status: 200 },
        { data: { error: "forbidden" }, status: 403 },
    ]) {
        const client = googleClient({ get: () => response });
        const { store } = await fixture(t, { httpClient: client });
        const imported = await store.importAccounts({
            client_id: "client",
            email: "owner@example.com",
            refresh_token: "opaque",
        });
        await assert.rejects(store.verifyAccount(imported.results[0].account.id), {
            code: response.status === 403 ? "identity_scope_missing" : "identity_unverified",
        });
        assert.equal((await store.listAccounts())[0].identityVerified, false);
    }
});

test("preserves a Google refresh-token rotation even when identity scope is missing", async t => {
    const client = googleClient({
        get: () => ({ data: {}, status: 403 }),
        post: () => ({ data: { access_token: "temporary-access", refresh_token: "rotated-refresh" }, status: 200 }),
    });
    const { filePath, store } = await fixture(t, { httpClient: client });
    const imported = await store.importAccounts({ client_id: "original-client", refresh_token: "original-refresh" });
    await assert.rejects(store.verifyAccount(imported.results[0].account.id), { code: "identity_scope_missing" });
    const saved = JSON.parse(await fs.readFile(filePath, "utf8")).accounts[0];
    assert.equal(saved.refreshToken, "rotated-refresh");
    assert.equal(saved.identityVerified, false);
    assert.equal(JSON.stringify(await store.listAccounts()).includes("rotated-refresh"), false);
});

test("internal token access lazily verifies once and reuses one memory-only token across concurrent requests", async t => {
    const client = googleClient({
        post: () => ({ data: { access_token: "cached-private-access", expires_in: 3600 }, status: 200 }),
    });
    const { filePath, store } = await fixture(t, { httpClient: client });
    const imported = await store.importAccounts({
        client_id: "original-client",
        email: "owner@example.com",
        refresh_token: "opaque",
    });
    const id = imported.results[0].account.id;
    const tokens = await Promise.all(Array.from({ length: 10 }, () => store.getAccessToken(id)));
    assert.equal(
        tokens.every(token => token.accessToken === "cached-private-access"),
        true
    );
    assert.equal(client.calls.filter(call => call.method === "post").length, 1);
    assert.equal(client.calls.filter(call => call.method === "get").length, 1);
    assert.ok(tokens[0].expiresAt > Date.now());
    assert.equal((await store.getAccessToken(id)).accessToken, "cached-private-access");
    assert.equal(client.calls.length, 2);
    assert.equal((await fs.readFile(filePath, "utf8")).includes("cached-private-access"), false);
    assert.equal(JSON.stringify(await store.listAccounts()).includes("cached-private-access"), false);
});

test("token expiry, credential replacement, environment-client secret changes and deletion invalidate token reuse", async t => {
    let now = 1000000;
    let tokenNumber = 0;
    const env = { GOOGLE_OAUTH_CLIENT_ID: "original-client", GOOGLE_OAUTH_CLIENT_SECRET: "original-secret" };
    const client = googleClient({
        post: () => ({ data: { access_token: `access-${++tokenNumber}`, expires_in: 3600 }, status: 200 }),
    });
    const { store } = await fixture(t, { env, httpClient: client, now: () => now });
    const imported = await store.importAccounts({ email: "owner@example.com", refresh_token: "original-refresh" });
    const id = imported.results[0].account.id;
    assert.equal((await store.getAccessToken(id)).accessToken, "access-1");
    now += 3600000;
    assert.equal((await store.getAccessToken(id)).accessToken, "access-2");
    await store.importAccounts({ email: "owner@example.com", refresh_token: "replacement-refresh" });
    assert.equal((await store.getAccessToken(id)).accessToken, "access-3");
    env.GOOGLE_OAUTH_CLIENT_SECRET = "replacement-client-secret";
    assert.equal((await store.getAccessToken(id)).accessToken, "access-4");
    await store.deleteAccount(id);
    await assert.rejects(store.getAccessToken(id), { code: "oauth_account_not_found" });
    assert.equal(tokenNumber, 4);
});

test("an explicitly expired returned access token is never reused for inference", async t => {
    const client = googleClient({
        post: () => ({ data: { access_token: "already-expired", expires_in: 0 }, status: 200 }),
    });
    const { store } = await fixture(t, { httpClient: client });
    const imported = await store.importAccounts({ client_id: "original-client", refresh_token: "opaque" });
    await assert.rejects(store.getAccessToken(imported.results[0].account.id), { code: "oauth_refresh_failed" });
    assert.equal(client.calls.filter(call => call.method === "get").length, 0);
});

test("sanitizes token endpoint failures and network errors instead of exposing credential material", async t => {
    for (const [response, expectedCode] of [
        [
            { data: { error: "invalid_grant", error_description: "credential-secret" }, status: 400 },
            "oauth_refresh_invalid",
        ],
        [null, "oauth_network_error"],
    ]) {
        const client = googleClient({
            post: () => {
                if (response) return response;
                throw new Error("request failed with credential-secret");
            },
        });
        const { store } = await fixture(t, { httpClient: client });
        const imported = await store.importAccounts({ client_id: "client", refresh_token: "credential-secret" });
        await assert.rejects(store.verifyAccount(imported.results[0].account.id), error => {
            assert.equal(error.code, expectedCode);
            assert.equal(JSON.stringify(error).includes("credential-secret"), false);
            assert.equal(error.message.includes("credential-secret"), false);
            return true;
        });
        assert.equal(JSON.stringify(await store.listAccounts()).includes("credential-secret"), false);
    }
});

test("corrupt existing sidecar fails closed and remains unchanged", async t => {
    const { filePath, store } = await fixture(t);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{broken-private-credential");
    await assert.rejects(store.importAccounts({ refresh_token: "new-token" }), { code: "oauth_store_unavailable" });
    assert.equal(await fs.readFile(filePath, "utf8"), "{broken-private-credential");
});

test("deletes only the selected OAuth sidecar record", async t => {
    const { filePath, store } = await fixture(t);
    const imported = await store.importAccounts([{ refresh_token: "one" }, { refresh_token: "two" }]);
    const nativeAuthPath = path.join(path.dirname(filePath), "auth-0.json");
    await fs.writeFile(nativeAuthPath, '{"cookies":[],"origins":[]}');
    assert.deepEqual(await store.deleteAccount(imported.results[0].account.id), { success: true });
    assert.equal((await store.listAccounts()).length, 1);
    assert.equal(await fs.readFile(nativeAuthPath, "utf8"), '{"cookies":[],"origins":[]}');
    await assert.rejects(store.deleteAccount(imported.results[0].account.id), { code: "oauth_account_not_found" });
});

test("HTTP routes require console authentication, disable caching, and return sanitized errors", async t => {
    const { store } = await fixture(t);
    const app = express();
    app.use(express.json());
    let channel = { mode: "build" };
    new OAuthAccountRoutes({
        oauthAccountStore: store,
        upstreamChannelStore: { get: async () => channel },
    }).setupRoutes(app, (req, res, next) => {
        if (req.headers.authorization !== "Bearer console-session") return res.sendStatus(401);
        next();
    });
    const server = await new Promise(resolve => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/oauth/accounts`)).status, 401);
    const headers = { Authorization: "Bearer console-session", "Content-Type": "application/json" };
    const response = await fetch(`${base}/api/oauth/accounts/import`, {
        body: JSON.stringify({ content: { email: "owner@example.com", refresh_token: "private-refresh-token" } }),
        headers,
        method: "POST",
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const imported = await response.json();
    assert.equal(JSON.stringify(imported).includes("private-refresh-token"), false);
    const id = imported.results[0].account.id;
    const verification = await fetch(`${base}/api/oauth/accounts/${id}/verify`, { headers, method: "POST" });
    assert.equal(verification.status, 400);
    assert.equal(verification.headers.get("Cache-Control"), "no-store");
    assert.equal((await verification.json()).code, "oauth_client_required");
    const listing = await fetch(`${base}/api/oauth/accounts`, { headers });
    assert.equal(listing.headers.get("Cache-Control"), "no-store");
    assert.equal((await listing.json()).accounts.length, 1);
    channel = { accountId: id, mode: "oauth" };
    const deletion = await fetch(`${base}/api/oauth/accounts/${id}`, { headers, method: "DELETE" });
    assert.equal(deletion.status, 409);
    assert.equal((await deletion.json()).code, "oauth_account_in_use");
    assert.equal((await store.listAccounts()).length, 1);
});
