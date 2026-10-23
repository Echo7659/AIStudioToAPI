const assert = require("node:assert/strict");
const fs = require("node:fs").promises;
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const UpstreamChannelStore = require("../src/core/UpstreamChannelStore");

test("channel settings persist an explicit paid account/project and fail closed on invalid configuration", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aistudio-channel-"));
    const filePath = path.join(directory, "upstream-channel.json");
    const store = new UpstreamChannelStore({ env: {}, filePath });
    try {
        assert.equal((await store.get()).mode, "build");
        await assert.rejects(store.set({ accountId: "id", mode: "oauth" }, [{ id: "id" }]), /cloud_project_required/);
        await assert.rejects(
            store.set({ accountId: "missing", mode: "oauth", projectId: "test" }, [{ id: "id" }]),
            /oauth_account_not_found/
        );
        await store.set({ accountId: "id", mode: "oauth", projectId: "cloud-project" }, [{ id: "id" }]);
        assert.equal((await new UpstreamChannelStore({ env: {}, filePath }).get()).projectId, "cloud-project");
        if (process.platform !== "win32") assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
        const managed = new UpstreamChannelStore({ env: { API_UPSTREAM_CHANNEL: "build" }, filePath });
        assert.equal((await managed.get()).managedByEnvironment, true);
        await assert.rejects(managed.set({ mode: "build" }, []), /channel_managed_by_environment/);
        await fs.writeFile(filePath, "broken");
        await assert.rejects(store.get(), /channel_config_unavailable/);
    } finally {
        await fs.rm(directory, { force: true, recursive: true });
    }
});

test("fixed OAuth target is independent of the default Build channel and never mutates its configuration", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aistudio-dual-channel-"));
    const filePath = path.join(directory, "upstream-channel.json");
    const env = { GOOGLE_OAUTH_ACCOUNT_ID: "oauth-id", GOOGLE_OAUTH_PROJECT_ID: "billing-project" };
    const store = new UpstreamChannelStore({ env, filePath });
    try {
        assert.equal((await store.get()).mode, "build");
        assert.deepEqual(await store.getOAuthTarget(), {
            accountId: "oauth-id",
            managedByEnvironment: true,
            mode: "oauth",
            projectId: "billing-project",
        });
        await assert.rejects(fs.stat(filePath), { code: "ENOENT" });
        env.API_UPSTREAM_CHANNEL = "build";
        assert.equal((await store.get()).mode, "build");
        assert.equal((await store.getOAuthTarget()).accountId, "oauth-id");
    } finally {
        await fs.rm(directory, { force: true, recursive: true });
    }
});

test("explicit OAuth target falls back only to a configured OAuth default and rejects absent or partial targets", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aistudio-target-"));
    const filePath = path.join(directory, "upstream-channel.json");
    const env = {};
    const store = new UpstreamChannelStore({ env, filePath });
    try {
        await assert.rejects(store.getOAuthTarget(), { code: "official_channel_not_configured", statusCode: 503 });
        await store.set({ accountId: "stored-id", mode: "oauth", projectId: "stored-project" }, [{ id: "stored-id" }]);
        assert.equal((await store.getOAuthTarget()).accountId, "stored-id");
        env.GOOGLE_OAUTH_ACCOUNT_ID = "explicit-id";
        await assert.rejects(store.getOAuthTarget(), { code: "cloud_project_required", statusCode: 503 });
        env.GOOGLE_OAUTH_PROJECT_ID = "bad\r\nproject";
        await assert.rejects(store.getOAuthTarget(), { code: "cloud_project_required", statusCode: 503 });
        env.GOOGLE_OAUTH_PROJECT_ID = "explicit-project";
        assert.equal((await store.getOAuthTarget()).accountId, "explicit-id");
        assert.equal((await store.get()).accountId, "stored-id");
    } finally {
        await fs.rm(directory, { force: true, recursive: true });
    }
});
