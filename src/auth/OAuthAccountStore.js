const crypto = require("crypto");
const fs = require("fs").promises;
const path = require("path");
const axios = require("axios");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ACCOUNTS = 1000;

class OAuthAccountError extends Error {
    constructor(code, statusCode = 400, account = undefined) {
        super(code);
        this.code = code;
        this.statusCode = statusCode;
        this.account = account;
    }
}

function text(value, maxLength = 16384) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > maxLength || /[\r\n\0]/.test(trimmed)) return null;
    return trimmed;
}

function normalizeEmail(value) {
    const email = text(value, 320);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
    return email.toLowerCase();
}

function firstValue(objects, keys) {
    for (const object of objects) {
        if (!object || typeof object !== "object" || Array.isArray(object)) continue;
        for (const key of keys) {
            if (object[key] !== undefined && object[key] !== null && object[key] !== "") return object[key];
        }
    }
    return null;
}

function parseAccount(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new OAuthAccountError("invalid_account");
    }
    if (input.type && !["authorized_user", "antigravity", "google_oauth"].includes(input.type)) {
        throw new OAuthAccountError("unsupported_credential_type");
    }
    if (input.cookies !== undefined || input.origins !== undefined) {
        throw new OAuthAccountError("browser_auth_requires_browser_import");
    }
    const sources = [input, input.token, input.credentials];
    const tokenUri = firstValue(sources, ["token_uri", "tokenUri", "token_url", "tokenUrl"]);
    if (tokenUri !== null && tokenUri !== TOKEN_URL) {
        throw new OAuthAccountError("unsupported_token_endpoint");
    }
    if (input.universe_domain && input.universe_domain !== "googleapis.com") {
        throw new OAuthAccountError("unsupported_google_domain");
    }
    const refreshToken = text(firstValue(sources, ["refresh_token", "refreshToken"]));
    if (!refreshToken) throw new OAuthAccountError("missing_refresh_token");
    const rawEmail = firstValue(sources, ["email", "accountName", "account"]);
    const email = normalizeEmail(rawEmail);
    if (rawEmail !== null && !email) throw new OAuthAccountError("invalid_email");

    const clientSources = [...sources, input.oauth_client, input.oauthClient, input.client];
    const rawClientId = firstValue(clientSources, ["client_id", "clientId", "oauth_client_id"]);
    const clientId = text(rawClientId, 1024);
    if (rawClientId !== null && (!clientId || clientId.includes("://"))) {
        throw new OAuthAccountError("invalid_oauth_client");
    }
    const rawSecret = firstValue(clientSources, ["client_secret", "clientSecret", "oauth_client_secret"]);
    const clientSecret = text(rawSecret);
    if (rawSecret !== null && !clientSecret) throw new OAuthAccountError("invalid_oauth_client");
    const rawProject = firstValue(sources, ["project_id", "projectId", "quota_project_id", "quotaProjectId"]);
    const projectId = text(rawProject, 128);
    if (rawProject !== null && (!projectId || !/^[A-Za-z0-9_.:-]+$/.test(projectId))) {
        throw new OAuthAccountError("invalid_project_id");
    }

    return {
        clientAlias: text(firstValue(sources, ["oauth_client_key", "oauthClientKey"]), 128),
        clientId,
        clientSecret,
        declaredEmail: email,
        email,
        errorCode: null,
        id: crypto.randomUUID(),
        identityVerified: false,
        lastVerifiedAt: null,
        projectId,
        refreshToken,
        subject: null,
    };
}

function parseImport(content) {
    let input = content;
    if (input && typeof input === "object") {
        try {
            if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_IMPORT_BYTES) {
                throw new OAuthAccountError("import_too_large");
            }
        } catch (error) {
            if (error instanceof OAuthAccountError) throw error;
            throw new OAuthAccountError("invalid_import");
        }
    }
    if (typeof input === "string") {
        if (Buffer.byteLength(input, "utf8") > MAX_IMPORT_BYTES) throw new OAuthAccountError("import_too_large");
        try {
            input = JSON.parse(input.replace(/^\uFEFF/, ""));
        } catch {
            throw new OAuthAccountError("invalid_json");
        }
    }
    if (!input || typeof input !== "object") throw new OAuthAccountError("invalid_import");
    let accounts;
    if (Array.isArray(input)) {
        accounts = input;
    } else if (Object.prototype.hasOwnProperty.call(input, "accounts")) {
        if (!Array.isArray(input.accounts)) throw new OAuthAccountError("invalid_accounts_array");
        accounts = input.accounts;
    } else {
        accounts = [input];
    }
    if (accounts.length === 0) throw new OAuthAccountError("empty_import");
    if (accounts.length > MAX_IMPORT_ACCOUNTS) throw new OAuthAccountError("too_many_accounts");
    return accounts;
}

class OAuthAccountStore {
    constructor(options = {}) {
        this.filePath = options.filePath || path.join(process.cwd(), "configs", "auth", "oauth-accounts.json");
        this.httpClient = options.httpClient || axios;
        this.env = options.env || process.env;
        this.timeoutMs = Math.min(Math.max(options.timeoutMs || 15000, 1), 30000);
        this.now = options.now || Date.now;
        this.queue = Promise.resolve();
        this.tokenCache = new Map();
        this.tokenRequests = new Map();
    }

    _serialize(action) {
        const operation = this.queue.then(action);
        this.queue = operation.catch(() => {});
        return operation;
    }

    async _readState() {
        try {
            const stat = await fs.lstat(this.filePath);
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not_regular_file");
            const state = JSON.parse(await fs.readFile(this.filePath, "utf8"));
            if (state.version !== 1 || !Array.isArray(state.accounts)) throw new Error("invalid_store");
            const ids = new Set();
            for (const account of state.accounts) {
                if (!account || typeof account.id !== "string" || ids.has(account.id) || !text(account.refreshToken)) {
                    throw new Error("invalid_account_record");
                }
                ids.add(account.id);
            }
            if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) {
                await fs.chmod(this.filePath, 0o600);
            }
            return state;
        } catch (error) {
            if (error.code === "ENOENT") return { accounts: [], version: 1 };
            throw new OAuthAccountError("oauth_store_unavailable", 503);
        }
    }

    async _writeState(state) {
        const directory = path.dirname(this.filePath);
        const temporaryPath = path.join(directory, `.oauth-accounts-${crypto.randomUUID()}.tmp`);
        let handle;
        try {
            await fs.mkdir(directory, { mode: 0o700, recursive: true });
            handle = await fs.open(temporaryPath, "wx", 0o600);
            await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
            await handle.sync();
            await handle.close();
            handle = null;
            await fs.rename(temporaryPath, this.filePath);
        } catch {
            throw new OAuthAccountError("oauth_store_unavailable", 503);
        } finally {
            if (handle) await handle.close().catch(() => {});
            await fs.unlink(temporaryPath).catch(() => {});
        }
    }

    _clientCredentials(account) {
        const environmentId = text(this.env.GOOGLE_OAUTH_CLIENT_ID, 1024);
        const clientId = account.clientId || environmentId;
        let clientSecret = account.clientSecret || null;
        if (!clientSecret && clientId === environmentId) clientSecret = text(this.env.GOOGLE_OAUTH_CLIENT_SECRET);
        return { clientId, clientSecret };
    }

    _summary(account) {
        return {
            email: account.email || null,
            errorCode: account.errorCode || null,
            id: account.id,
            identityVerified: account.identityVerified === true,
            lastVerifiedAt: account.lastVerifiedAt || null,
            needsOAuthClient: !this._clientCredentials(account).clientId,
            projectId: account.projectId || null,
        };
    }

    _credentialKey(account) {
        return crypto
            .createHash("sha256")
            .update(
                JSON.stringify({
                    client: this._clientCredentials(account),
                    declaredEmail: account.declaredEmail,
                    email: account.email,
                    identityVerified: account.identityVerified,
                    projectId: account.projectId,
                    refreshToken: account.refreshToken,
                    subject: account.subject,
                })
            )
            .digest("hex");
    }

    _cachedToken(account) {
        const cached = this.tokenCache.get(account.id);
        if (!cached || cached.key !== this._credentialKey(account) || this.now() >= cached.refreshAt) return null;
        return { ...cached.token };
    }

    // Internal transport capability. HTTP routes only expose the public summary.
    async getAccessToken(id) {
        const snapshot = await this._serialize(async () => {
            const state = await this._readState();
            const account = state.accounts.find(item => item.id === id);
            if (!account) throw new OAuthAccountError("oauth_account_not_found", 404);
            return { cached: this._cachedToken(account), key: this._credentialKey(account) };
        });
        if (snapshot.cached) return snapshot.cached;
        const requestKey = `${id}:${snapshot.key}`;
        if (this.tokenRequests.has(requestKey)) return this.tokenRequests.get(requestKey);
        const operation = this.verifyAccount(id).then(() =>
            this._serialize(async () => {
                const state = await this._readState();
                const account = state.accounts.find(item => item.id === id);
                if (!account) throw new OAuthAccountError("oauth_account_not_found", 404);
                const token = this._cachedToken(account);
                if (!token) throw new OAuthAccountError("oauth_credentials_changed", 409);
                return token;
            })
        );
        this.tokenRequests.set(requestKey, operation);
        try {
            return await operation;
        } finally {
            if (this.tokenRequests.get(requestKey) === operation) this.tokenRequests.delete(requestKey);
        }
    }

    async listAccounts() {
        return this._serialize(async () => {
            const state = await this._readState();
            return state.accounts.map(account => this._summary(account));
        });
    }

    async importAccounts(content) {
        const inputs = parseImport(content);
        return this._serialize(async () => {
            const state = await this._readState();
            const results = inputs.map((input, index) => {
                try {
                    const parsed = parseAccount(input);
                    const tokenMatch = state.accounts.find(account => account.refreshToken === parsed.refreshToken);
                    const emailMatch = parsed.email && state.accounts.find(account => account.email === parsed.email);
                    if (
                        (tokenMatch && parsed.email && tokenMatch.email && tokenMatch.email !== parsed.email) ||
                        (tokenMatch && emailMatch && tokenMatch.id !== emailMatch.id)
                    ) {
                        throw new OAuthAccountError("credential_identity_conflict");
                    }
                    const existing = tokenMatch || emailMatch;
                    let account = parsed;
                    if (existing) {
                        const clientId = parsed.clientId || existing.clientId;
                        const clientSecret =
                            parsed.clientSecret || (clientId === existing.clientId ? existing.clientSecret : null);
                        const unchanged =
                            existing.refreshToken === parsed.refreshToken &&
                            existing.clientId === clientId &&
                            existing.clientSecret === clientSecret;
                        account = {
                            ...parsed,
                            clientAlias: parsed.clientAlias || existing.clientAlias,
                            clientId,
                            clientSecret,
                            declaredEmail: parsed.declaredEmail || existing.declaredEmail,
                            email: parsed.email || existing.email,
                            id: existing.id,
                            projectId: parsed.projectId || existing.projectId,
                        };
                        if (unchanged) {
                            account.identityVerified = existing.identityVerified;
                            account.lastVerifiedAt = existing.lastVerifiedAt;
                            account.errorCode = existing.errorCode;
                            account.subject = existing.subject;
                        } else {
                            this.tokenCache.delete(existing.id);
                        }
                        state.accounts[state.accounts.indexOf(existing)] = account;
                    } else {
                        state.accounts.push(account);
                    }
                    return { account: this._summary(account), index, success: true };
                } catch (error) {
                    return {
                        code: error instanceof OAuthAccountError ? error.code : "invalid_account",
                        index,
                        success: false,
                    };
                }
            });
            const successCount = results.filter(result => result.success).length;
            if (successCount > 0) await this._writeState(state);
            return { failureCount: results.length - successCount, results, successCount };
        });
    }

    async deleteAccount(id) {
        return this._serialize(async () => {
            const state = await this._readState();
            const index = state.accounts.findIndex(account => account.id === id);
            if (index < 0) throw new OAuthAccountError("oauth_account_not_found", 404);
            state.accounts.splice(index, 1);
            await this._writeState(state);
            this.tokenCache.delete(id);
            return { success: true };
        });
    }

    async verifyAccount(id) {
        return this._serialize(async () => {
            const state = await this._readState();
            const account = state.accounts.find(item => item.id === id);
            if (!account) throw new OAuthAccountError("oauth_account_not_found", 404);
            const fail = async (code, statusCode = 400, invalidateIdentity = false) => {
                this.tokenCache.delete(id);
                account.errorCode = code;
                if (invalidateIdentity) account.identityVerified = false;
                await this._writeState(state);
                throw new OAuthAccountError(code, statusCode, this._summary(account));
            };
            const { clientId, clientSecret } = this._clientCredentials(account);
            if (!clientId) return fail("oauth_client_required");

            const requestOptions = {
                maxBodyLength: 65536,
                maxContentLength: 1024 * 1024,
                maxRedirects: 0,
                signal: AbortSignal.timeout(this.timeoutMs * 2),
                timeout: this.timeoutMs,
                validateStatus: () => true,
            };
            const form = new URLSearchParams({
                client_id: clientId,
                grant_type: "refresh_token",
                refresh_token: account.refreshToken,
            });
            if (clientSecret) form.set("client_secret", clientSecret);
            let refresh;
            try {
                refresh = await this.httpClient.post(TOKEN_URL, form.toString(), {
                    ...requestOptions,
                    headers: { "Content-Type": "application/x-www-form-urlencoded" },
                });
            } catch (error) {
                const code = ["ECONNABORTED", "ETIMEDOUT", "ERR_CANCELED"].includes(error.code)
                    ? "oauth_timeout"
                    : "oauth_network_error";
                return fail(code, 502);
            }
            if (refresh.status < 200 || refresh.status >= 300) {
                const errorCodes = new Map([
                    ["invalid_client", "oauth_client_invalid"],
                    ["invalid_grant", "oauth_refresh_invalid"],
                    ["invalid_scope", "oauth_scope_unavailable"],
                ]);
                const code = errorCodes.get(refresh.data?.error) || "oauth_refresh_failed";
                return fail(code, 400, code === "oauth_refresh_invalid");
            }
            const accessToken = text(refresh.data?.access_token);
            const returnedLifetime = Number(refresh.data?.expires_in);
            if (
                !accessToken ||
                (refresh.data.expires_in !== undefined &&
                    (!Number.isFinite(returnedLifetime) || returnedLifetime <= 0)) ||
                (refresh.data.token_type &&
                    (typeof refresh.data.token_type !== "string" || refresh.data.token_type.toLowerCase() !== "bearer"))
            ) {
                return fail("oauth_refresh_failed", 502);
            }
            // A refresh-token rotation must survive a later userinfo failure.
            account.clientId = clientId;
            const rotatedRefreshToken = text(refresh.data.refresh_token);
            if (rotatedRefreshToken) account.refreshToken = rotatedRefreshToken;

            let identity;
            try {
                identity = await this.httpClient.get(USERINFO_URL, {
                    ...requestOptions,
                    headers: { Authorization: `Bearer ${accessToken}` },
                });
            } catch (error) {
                const code = ["ECONNABORTED", "ETIMEDOUT", "ERR_CANCELED"].includes(error.code)
                    ? "oauth_timeout"
                    : "oauth_network_error";
                return fail(code, 502);
            }
            if (identity.status < 200 || identity.status >= 300) {
                return fail(identity.status === 403 ? "identity_scope_missing" : "identity_verification_failed", 400);
            }
            const email = normalizeEmail(identity.data?.email);
            const subject = text(identity.data?.sub, 255);
            if (!email || !subject || identity.data.email_verified !== true) return fail("identity_unverified");
            if (
                (account.declaredEmail && account.declaredEmail !== email) ||
                (account.subject && account.subject !== subject)
            ) {
                return fail("identity_mismatch", 400, true);
            }

            account.email = email;
            account.subject = subject;
            account.identityVerified = true;
            account.lastVerifiedAt = new Date(this.now()).toISOString();
            account.errorCode = null;
            await this._writeState(state);
            const lifetimeMs =
                (Number.isFinite(returnedLifetime) && returnedLifetime > 0 ? Math.min(returnedLifetime, 86400) : 60) *
                1000;
            this.tokenCache.set(id, {
                key: this._credentialKey(account),
                refreshAt: this.now() + lifetimeMs - Math.min(60000, lifetimeMs / 10),
                token: {
                    accessToken,
                    email: account.email,
                    expiresAt: this.now() + lifetimeMs,
                    projectId: account.projectId,
                },
            });
            return this._summary(account);
        });
    }
}

OAuthAccountStore.OAuthAccountError = OAuthAccountError;
module.exports = OAuthAccountStore;
