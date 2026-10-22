const AccountInsightsService = require("../core/AccountInsightsService");

class AccountInsightsRoutes {
    constructor(serverSystem) {
        this.serverSystem = serverSystem;
        this.service = new AccountInsightsService(serverSystem);
    }

    setupRoutes(app, isAuthenticated) {
        const handle = refresh => async (req, res) => {
            res.set("Cache-Control", "no-store");
            if (!/^\d+$/.test(req.params.index)) {
                return res.status(400).json({ code: "invalid_account" });
            }
            const index = Number(req.params.index);
            if (!Number.isSafeInteger(index) || !this.serverSystem.authSource.availableIndices.includes(index)) {
                return res.status(404).json({ code: "account_not_found" });
            }
            if (this.serverSystem.requestHandler?.isSystemBusy) {
                return res.status(409).json({ code: "system_busy" });
            }
            try {
                const snapshot = await this.service.get(index, { refresh });
                return res.json(snapshot);
            } catch {
                return res.status(502).json({ code: "insights_unavailable" });
            }
        };
        app.get("/api/accounts/:index/insights", isAuthenticated, handle(false));
        app.post("/api/accounts/:index/insights/refresh", isAuthenticated, handle(true));

        const oauthInsights = refresh => async (req, res) => {
            res.set("Cache-Control", "no-store");
            try {
                const account = (await this.serverSystem.oauthAccountStore.listAccounts()).find(
                    item => item.id === req.params.id
                );
                if (!account) return res.status(404).json({ code: "oauth_account_not_found" });
                const index =
                    account.identityVerified && account.email
                        ? this.serverSystem.authSource.availableIndices.find(
                              candidate =>
                                  String(
                                      this.serverSystem.authSource.accountNameMap.get(candidate) || ""
                                  ).toLowerCase() === account.email.toLowerCase()
                          )
                        : undefined;
                if (index === undefined) {
                    const snapshot = await this.service.get(-1);
                    const reason = account.identityVerified
                        ? "browser_context_unavailable"
                        : "oauth_identity_unverified";
                    snapshot.balance.reason = reason;
                    snapshot.quota.reason = reason;
                    return res.json(snapshot);
                }
                if (this.serverSystem.requestHandler?.isSystemBusy)
                    return res.status(409).json({ code: "system_busy" });
                return res.json(await this.service.get(index, { refresh }));
            } catch {
                return res.status(502).json({ code: "insights_unavailable" });
            }
        };
        app.get("/api/oauth/accounts/:id/insights", isAuthenticated, oauthInsights(false));
        app.post("/api/oauth/accounts/:id/insights/refresh", isAuthenticated, oauthInsights(true));
    }
}

module.exports = AccountInsightsRoutes;
