/**
 * MatchingService
 * Manages product matches, approvals, overrides, and rematch requests.
 */
var MatchingService = (function() {

  /**
   * Fetch all matches.
   */
  function getMatches() {
    var sql = "SELECT * FROM product_matches ORDER BY confidence_score DESC";
    return BigQueryService.query(sql);
  }

  /**
   * Set is_approved = true for a given match.
   */
  function approveMatch(sku, competitor) {
    if (!BigQueryService.useBigQuery()) {
      var matches = BigQueryService.getMockMatches();
      for (var i = 0; i < matches.length; i++) {
        if (matches[i].product_sku === sku && matches[i].competitor === competitor) {
          matches[i].is_approved = true;
          BigQueryService.saveMockMatch(matches[i]);
          return true;
        }
      }
      return false;
    }
    
    // In production BigQuery
    var dataset = BigQueryService.getDataset();
    var sql = "UPDATE `" + dataset + ".product_matches` SET is_approved = TRUE WHERE product_sku = '" + sku + "' AND competitor = '" + competitor + "'";
    BigQueryService.executeDML(sql);
    MetricService.invalidateCache();
    return true;
  }

  /**
   * Save a manual override match.
   */
  function saveManualOverride(sku, competitor, productName, price, explanation) {
    var matchObj = {
      product_sku: sku,
      competitor: competitor,
      competitor_product_name: productName,
      latest_price: parseFloat(price) || 0,
      confidence_score: 100.0,
      match_method: "manual_override",
      match_explanation: explanation || "Manually matched by administrator",
      is_approved: true,
      last_matched_date: Utilities.formatDate(new Date(), "GMT+1", "yyyy-MM-dd HH:mm:ss")
    };

    if (!BigQueryService.useBigQuery()) {
      BigQueryService.saveMockMatch(matchObj);
      MetricService.invalidateCache();
      return true;
    }

    // In production BigQuery: Delete old match and insert new manual override row
    var dataset = BigQueryService.getDataset();
    var deleteSql = "DELETE FROM `" + dataset + ".product_matches` WHERE product_sku = '" + sku + "' AND competitor = '" + competitor + "'";
    BigQueryService.executeDML(deleteSql);
    
    var insertSql = "INSERT INTO `" + dataset + ".product_matches` (product_sku, competitor, competitor_product_name, latest_price, confidence_score, match_method, match_explanation, is_approved, needs_rematch, last_matched_date) VALUES " +
        "('" + sku + "', '" + competitor + "', '" + productName + "', " + price + ", 100.0, 'manual_override', '" + explanation + "', TRUE, FALSE, CURRENT_TIMESTAMP())";
    BigQueryService.executeDML(insertSql);
    
    MetricService.invalidateCache();
    return true;
  }

  /**
   * Trigger the Python rematching workflow.
   */
  function triggerRematch(sku) {
    if (!BigQueryService.useBigQuery()) {
      Logger.log("Triggered mock rematch for SKU: " + sku);
      return { success: true, message: "Mock rematch triggered successfully for SKU: " + sku };
    }

    try {
      // Flag in BigQuery matches table
      var dataset = BigQueryService.getDataset();
      var sql = "UPDATE `" + dataset + ".product_matches` SET needs_rematch = TRUE WHERE product_sku = '" + sku + "'";
      BigQueryService.executeDML(sql);
      MetricService.invalidateCache();
      
      // Dispatch webhook/trigger event to GitHub Actions
      var settings = SettingsService.getSettings();
      if (settings.github.pat && settings.github.repo) {
        var url = "https://api.github.com/repos/" + settings.github.repo + "/dispatches";
        var headers = {
          "Authorization": "token " + settings.github.pat,
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "PriceGuard-GAS-App"
        };
        var payload = {
          event_type: "run_rematch",
          client_payload: { sku: sku }
        };
        
        var response = UrlFetchApp.fetch(url, {
          method: "post",
          headers: headers,
          contentType: "application/json",
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
        
        var code = response.getResponseCode();
        if (code === 204 || code === 200 || code === 201) {
          return { success: true, message: "Rematch triggered successfully via GitHub Actions." };
        } else {
          return { success: false, message: "GitHub API returned code: " + code + ". Body: " + response.getContentText() };
        }
      }
      return { success: true, message: "Product flagged for rematching. GitHub Actions configuration missing, dispatch skipped." };
    } catch(err) {
      return { success: false, message: "Rematch dispatch failed: " + err.toString() };
    }
  }

  return {
    getMatches: getMatches,
    approveMatch: approveMatch,
    saveManualOverride: saveManualOverride,
    triggerRematch: triggerRematch
  };
})();
