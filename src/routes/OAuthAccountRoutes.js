const OAuthAccountStore = require("../auth/OAuthAccountStore");
const { ChannelConfigError } = require("../core/UpstreamChannelStore");

class OAuthAccountRoutes {
    constructor(serverSystem) {
        this.serverSystem = serverSystem;
        this.store = serverSystem.oauthAccountStore || new OAuthAccountStore();
        serverSystem.oauthAccountStore = this.store;
    }

    async _respond(res, action) {
        res.set("Cache-Control", "no-store");
        try {
            await action();
        } catch (error) {
            if (error instanceof OAuthAccountStore.OAuthAccountError || error instanceof ChannelConfigError) {
                return res.status(error.statusCode).json({
                    ...(error.account ? { account: error.account } : {}),
                    code: error.code,
                });
            }
            return res.status(500).json({ code: "oauth_store_unavailable" });
        }
    }

    setupRoutes(app, isAuthenticated) {
        app.get("/api/oauth/accounts", isAuthenticated, (req, res) =>
            this._respond(res, async () => {
                res.json({ accounts: await this.store.listAccounts() });
            })
        );
        app.post("/api/oauth/accounts/import", isAuthenticated, (req, res) =>
            this._respond(res, async () => {
                const result = await this.store.importAccounts(req.body?.content);
                let status = 200;
                if (result.failureCount > 0) status = result.successCount > 0 ? 207 : 400;
                res.status(status).json(result);
            })
        );
        app.post("/api/oauth/accounts/:id/verify", isAuthenticated, (req, res) =>
            this._respond(res, async () => {
                res.json({ account: await this.store.verifyAccount(req.params.id) });
            })
        );
        app.delete("/api/oauth/accounts/:id", isAuthenticated, (req, res) =>
            this._respond(res, async () => {
                const channel = await this.serverSystem.upstreamChannelStore?.get();
                if (channel?.mode === "oauth" && channel.accountId === req.params.id) {
                    return res.status(409).json({ code: "oauth_account_in_use" });
                }
                if (this.serverSystem.upstreamChannelStore?.getOAuthTarget) {
                    try {
                        const target = await this.serverSystem.upstreamChannelStore.getOAuthTarget();
                        if (target.accountId === req.params.id) {
                            return res.status(409).json({ code: "oauth_account_in_use" });
                        }
                    } catch (error) {
                        if (error.code !== "official_channel_not_configured") throw error;
                    }
                }
                res.json(await this.store.deleteAccount(req.params.id));
            })
        );
    }
}

module.exports = OAuthAccountRoutes;
