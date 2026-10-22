const UpstreamChannelStore = require("../core/UpstreamChannelStore");

class UpstreamChannelRoutes {
    constructor(serverSystem) {
        this.serverSystem = serverSystem;
        this.store = serverSystem.upstreamChannelStore || new UpstreamChannelStore();
        serverSystem.upstreamChannelStore = this.store;
    }

    setupRoutes(app, isAuthenticated) {
        const respond = action => async (req, res) => {
            res.set("Cache-Control", "no-store");
            try {
                return res.json(await action(req));
            } catch (error) {
                return res.status(error.statusCode || 503).json({ code: error.code || "channel_config_unavailable" });
            }
        };
        app.get(
            "/api/settings/upstream-channel",
            isAuthenticated,
            respond(() => this.store.get())
        );
        app.put(
            "/api/settings/upstream-channel",
            isAuthenticated,
            respond(async req => {
                const accounts =
                    req.body?.mode === "oauth" ? await this.serverSystem.oauthAccountStore.listAccounts() : [];
                return this.store.set(req.body, accounts);
            })
        );
    }
}

module.exports = UpstreamChannelRoutes;
