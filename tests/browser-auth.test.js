const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { parseBrowserAuth } = require("../src/auth/BrowserAuth");
const StatusRoutes = require("../src/routes/StatusRoutes");
const AuthSource = require("../src/auth/AuthSource");

const state = {
    accountName: "test@example.com",
    cookies: [
        {
            domain: ".google.com",
            expires: -1,
            httpOnly: true,
            name: "SID",
            path: "/",
            sameSite: "Lax",
            secure: true,
            value: "test-cookie",
        },
    ],
    origins: [],
};
const logger = { error() {}, info() {}, warn() {} };

test("browser states retain metadata while OAuth-only and malformed states are rejected", () => {
    assert.deepEqual(parseBrowserAuth(JSON.stringify(state)), state);
    assert.throws(() => parseBrowserAuth({ email: "test@example.com", refresh_token: "private" }), /OAuth JSON/);
    assert.throws(() => parseBrowserAuth({ cookies: [] }), /cookies/);
    assert.throws(
        () => parseBrowserAuth({ ...state, origins: [{ localStorage: [], origin: "file:///private" }] }),
        /origin/
    );
    assert.throws(() => parseBrowserAuth({ cookies: [{ ...state.cookies[0], sameSite: "invalid" }] }), /cookie/);
    assert.throws(
        () => parseBrowserAuth('{"secret":"do-not-echo"'),
        error => !error.message.includes("do-not-echo")
    );
});

test("concurrent uploads preserve existing invalid files, private permissions and browser-only rotation", async () => {
    const cwd = process.cwd();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "aistudio-browser-auth-"));
    try {
        process.chdir(root);
        fs.mkdirSync(path.join(root, "configs", "auth"), { recursive: true });
        const reservedPath = path.join(root, "configs", "auth", "auth-7.json");
        const invalidAuth = JSON.stringify({ email: "test@example.com", refresh_token: "private" });
        fs.writeFileSync(reservedPath, invalidAuth);
        fs.writeFileSync(path.join(root, "configs", "auth", "oauth-accounts.json"), "[]");
        const routes = new StatusRoutes({ config: {}, logger });
        const names = await Promise.all(Array.from({ length: 5 }, () => routes._saveBrowserAuth(state)));
        assert.equal(new Set(names).size, 5);
        assert.equal(fs.readFileSync(reservedPath, "utf8"), invalidAuth);
        for (const name of names) {
            if (process.platform !== "win32")
                assert.equal(fs.statSync(path.join(root, "configs", "auth", name)).mode & 0o777, 0o600);
        }
        const auth = new AuthSource(logger);
        assert.equal(auth.availableIndices.length, 5);
        assert.equal(auth.availableIndices.includes(7), false);
        assert.equal(auth.getRotationIndices().length, 1);
    } finally {
        process.chdir(cwd);
        fs.rmSync(root, { force: true, recursive: true });
    }
});
