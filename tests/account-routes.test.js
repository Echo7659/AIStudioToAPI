const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const express = require("express");
const WebRoutes = require("../src/routes/WebRoutes");

test("account endpoints require a console session and keep OAuth secrets out of browser accounts", async () => {
    const originalDirectory = process.cwd();
    const previousEnvironment = Object.fromEntries(
        ["WEB_CONSOLE_USERNAME", "WEB_CONSOLE_PASSWORD", "GOOGLE_OAUTH_CLIENT_ID"].map(key => [key, process.env[key]])
    );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-account-routes-"));
    process.chdir(directory);
    process.env.WEB_CONSOLE_USERNAME = "admin";
    process.env.WEB_CONSOLE_PASSWORD = "test-console-password";
    process.env.GOOGLE_OAUTH_CLIENT_ID = "";
    const app = express();
    app.use(express.json());
    const system = {
        authSource: {
            accountNameMap: new Map([[0, "browser@example.com"]]),
            availableIndices: [0],
            getAuth: () => ({ accountName: "browser@example.com", cookies: [] }),
        },
        browserManager: { contexts: new Map() },
        config: { apiKeys: ["inference-only-key"] },
        logger: { error() {}, info() {}, warn() {} },
        requestHandler: { isSystemBusy: false },
    };
    new WebRoutes(system).setupSession(app);
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (url, method = "GET", body = undefined, cookie = undefined) =>
        fetch(base + url, {
            body: body === undefined ? undefined : JSON.stringify(body),
            headers: {
                Accept: "application/json",
                Authorization: "Bearer inference-only-key",
                "Content-Type": "application/json",
                ...(cookie ? { Cookie: cookie } : {}),
            },
            method,
            redirect: "manual",
        });
    try {
        for (const [url, method] of [
            ["/api/oauth/accounts", "GET"],
            ["/api/oauth/accounts/import", "POST"],
            ["/api/oauth/accounts/test/verify", "POST"],
            ["/api/oauth/accounts/test", "DELETE"],
            ["/api/accounts/0/insights", "GET"],
            ["/api/accounts/0/insights/refresh", "POST"],
            ["/api/settings/upstream-channel", "GET"],
            ["/api/settings/upstream-channel", "PUT"],
        ]) {
            assert.equal((await request(url, method)).status, 401);
        }
        const login = await request("/login", "POST", { password: "test-console-password", username: "admin" });
        assert.equal(login.status, 302);
        const cookie = login.headers
            .getSetCookie()
            .map(value => value.split(";")[0])
            .join("; ");
        assert.ok(cookie);
        const imported = await request(
            "/api/oauth/accounts/import",
            "POST",
            {
                content: {
                    accounts: [{ email: "oauth@example.com", refresh_token: "do-not-return-this-refresh-token" }],
                },
            },
            cookie
        );
        assert.equal(imported.status, 200);
        assert.equal(imported.headers.get("cache-control"), "no-store");
        const result = await imported.json();
        const account = result.results[0].account;
        assert.equal(result.successCount, 1);
        assert.equal(account.identityVerified, false);
        assert.equal(account.needsOAuthClient, true);
        assert.equal(JSON.stringify(result).includes("do-not-return"), false);
        assert.deepEqual(system.authSource.availableIndices, [0]);
        const listing = await request("/api/oauth/accounts", "GET", undefined, cookie);
        assert.equal(JSON.stringify(await listing.json()).includes("do-not-return"), false);
        const verified = await request(`/api/oauth/accounts/${account.id}/verify`, "POST", undefined, cookie);
        assert.equal(verified.status, 400);
        assert.equal((await verified.json()).code, "oauth_client_required");
        assert.equal((await request("/api/files/oauth-accounts.json", "GET", undefined, cookie)).status, 400);
        assert.equal((await request("/api/accounts/9/insights", "GET", undefined, cookie)).status, 404);
        assert.equal((await request("/api/accounts/bad/insights", "GET", undefined, cookie)).status, 400);
        const insights = await request("/api/accounts/0/insights", "GET", undefined, cookie);
        assert.equal(insights.status, 200);
        const snapshot = await insights.json();
        assert.equal(snapshot.balance.prepaid, null);
        assert.equal(snapshot.quota.status, "unavailable");
        const oauthInsights = await request(`/api/oauth/accounts/${account.id}/insights`, "GET", undefined, cookie);
        assert.equal((await oauthInsights.json()).balance.reason, "oauth_identity_unverified");
        const channel = await request(
            "/api/settings/upstream-channel",
            "PUT",
            {
                accountId: account.id,
                mode: "oauth",
                projectId: "test-project",
            },
            cookie
        );
        assert.equal(channel.status, 200);
        assert.equal((await request(`/api/oauth/accounts/${account.id}`, "DELETE", undefined, cookie)).status, 409);
        assert.equal((await request("/api/settings/upstream-channel", "PUT", { mode: "build" }, cookie)).status, 200);
        assert.equal((await request(`/api/oauth/accounts/${account.id}`, "DELETE", undefined, cookie)).status, 200);
        assert.equal((await request(`/api/oauth/accounts/${account.id}`, "DELETE", undefined, cookie)).status, 404);
    } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        process.chdir(originalDirectory);
        for (const [key, value] of Object.entries(previousEnvironment)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(directory, { force: true, recursive: true });
    }
});
