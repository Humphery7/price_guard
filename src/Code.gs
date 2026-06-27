/**
 * Price Guard Web App Main Entry Point
 * Exposes RPC functions for client UI pages, handles Web App GET request router,
 * and orchestrates the automated daily pipeline.
 */

// ═══════════════════════════════════════════════════════════════
// WEB APP ENTRY POINT
// ═══════════════════════════════════════════════════════════════

/**
 * Handle HTTP GET request to render Web App.
 */
function doGet(e) {
  var template = HtmlService.createTemplateFromFile("UI/index");
  return template.evaluate()
    .setTitle("Price Guard – Pricing Intelligence")
    .setSandboxMode(HtmlService.SandboxMode.IFRAME)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

/**
 * Helper to include other HTML files inline in the main shell.
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ═══════════════════════════════════════════════════════════════
// RPC ENDPOINTS (Called by client-side JavaScript)
// ═══════════════════════════════════════════════════════════════

/**
 * RPC: Retrieve consolidated datasets for page load optimization.
 * In BigQuery mode, reads from precomputed snapshots for speed.
 */
function getCompositeDashboardData() {
  var products = MetricSnapshotService.getLatestMetricsSnapshot();
  var alerts = MetricSnapshotService.getLatestAlertsSnapshot();

  // Compute summary from the snapshot data
  var summary = computeSummaryFromProducts(products);

  // Supplier and category health from snapshot data
  var suppliers = computeSupplierHealthFromProducts(products);
  var categories = computeCategoryHealthFromProducts(products);

  return {
    summary: summary,
    products: products,
    suppliers: suppliers,
    categories: categories,
    alerts: alerts,
    matches: MatchingService.getMatches(),
    settings: SettingsService.getSettings()
  };
}

/**
 * RPC: Retrieve Dashboard Summary Card Metrics.
 */
function getDashboardSummary() {
  var products = MetricSnapshotService.getLatestMetricsSnapshot();
  return computeSummaryFromProducts(products);
}

/**
 * RPC: Retrieve Complete Catalog with calculated metrics.
 */
function getProductsList() {
  return MetricSnapshotService.getLatestMetricsSnapshot();
}

/**
 * RPC: Retrieve Category scorecards.
 */
function getCategoryHealth() {
  var products = MetricSnapshotService.getLatestMetricsSnapshot();
  return computeCategoryHealthFromProducts(products);
}

/**
 * RPC: Retrieve Supplier scorecards.
 */
function getSupplierHealth() {
  var products = MetricSnapshotService.getLatestMetricsSnapshot();
  return computeSupplierHealthFromProducts(products);
}

/**
 * RPC: Retrieve pricing anomalies list.
 */
function getAlertsList() {
  return MetricSnapshotService.getLatestAlertsSnapshot();
}

/**
 * RPC: Retrieve competitor match queue.
 */
function getMatchesList() {
  return MatchingService.getMatches();
}

/**
 * RPC: Approve a candidate match.
 */
function approveMatch(sku, competitor) {
  return MatchingService.approveMatch(sku, competitor);
}

/**
 * RPC: Manually force/create a product match.
 */
function saveManualOverride(sku, competitor, name, price, explanation) {
  return MatchingService.saveManualOverride(sku, competitor, name, price, explanation);
}

/**
 * RPC: Flag a product and trigger matching engine.
 */
function triggerRematch(sku) {
  return MatchingService.triggerRematch(sku);
}

/**
 * RPC: Retrieve system thresholds.
 */
function getSystemSettings() {
  return SettingsService.getSettings();
}

/**
 * RPC: Update system thresholds.
 */
function saveSystemSettings(settings) {
  return SettingsService.saveSettings(settings);
}

/**
 * RPC: Execute daily sync workflow manually from dashboard.
 * Runs the full pipeline on-demand.
 */
function runDailySyncJob() {
  Logger.log("Manual daily sync triggered from dashboard.");
  var report = executeDailyPipeline_();
  return {
    success: report.overall_success,
    report: report,
    timestamp: new Date().toISOString()
  };
}

/**
 * RPC: Get pipeline run status / last run info.
 */
function getPipelineStatus() {
  var props = PropertiesService.getScriptProperties();
  var lastRun = props.getProperty("LAST_PIPELINE_RUN");
  var lastStatus = props.getProperty("LAST_PIPELINE_STATUS");
  return {
    last_run: lastRun || "Never",
    last_status: lastStatus || "Unknown",
    db_mode: BigQueryService.getDbMode(),
    project_id: BigQueryService.getProjectId() || "Not configured",
    dataset: BigQueryService.getDataset()
  };
}

// ═══════════════════════════════════════════════════════════════
// DAILY PIPELINE ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════

/**
 * Scheduled Trigger Endpoint for Apps Script Time Triggers.
 * This is the function that runs every morning at 8 AM WAT.
 * 
 * Pipeline Steps:
 * 1. Ensure BigQuery tables exist (schema bootstrap)
 * 2. Refresh internal product catalog from Glovo DWH
 * 3. Ingest SPAR & SuperSaver data from Connected Sheets
 * 4. Dispatch Mano & Chowdeck scrapers via GitHub Actions
 * 5. Compute and persist daily metrics snapshot
 * 6. Compute and persist daily alerts snapshot
 * 7. Send email alerts digest to stakeholders
 */
function scheduledDailyJobTrigger() {
  Logger.log("═══════════════════════════════════════════════════");
  Logger.log("Price Guard Daily Pipeline — " + new Date().toISOString());
  Logger.log("═══════════════════════════════════════════════════");

  var report = executeDailyPipeline_();

  // Persist run metadata for status reporting
  var props = PropertiesService.getScriptProperties();
  props.setProperty("LAST_PIPELINE_RUN", new Date().toISOString());
  props.setProperty("LAST_PIPELINE_STATUS", report.overall_success ? "SUCCESS" : "PARTIAL_FAILURE");

  Logger.log("═══════════════════════════════════════════════════");
  Logger.log("Pipeline completed. Overall success: " + report.overall_success);
  Logger.log("═══════════════════════════════════════════════════");
}

/**
 * Internal: Execute the full daily pipeline.
 * @returns {Object} Detailed report of each step.
 * @private
 */
function executeDailyPipeline_() {
  var report = {
    overall_success: false,
    steps: {},
    started_at: new Date().toISOString(),
    completed_at: null
  };

  try {
    // Step 1: Schema Bootstrap
    Logger.log("[Step 1/7] Ensuring BigQuery tables exist...");
    report.steps.schema = SchemaService.ensureTablesExist();

    // Step 2: Refresh Internal Catalog
    Logger.log("[Step 2/7] Refreshing internal product catalog...");
    report.steps.catalog = DataIngestionService.refreshInternalCatalog();

    // Step 3: Ingest Partner Competitor Data
    Logger.log("[Step 3/7] Ingesting partner competitor data (SPAR, SuperSaver)...");
    report.steps.partners = DataIngestionService.ingestPartnerCompetitors();

    // Step 4: Dispatch Scraper Pipeline (async — doesn't block)
    Logger.log("[Step 4/7] Dispatching scraper pipeline (Mano, Chowdeck)...");
    report.steps.scrapers = DataIngestionService.triggerScraperPipeline();

    // Step 5: Compute and Persist Daily Metrics
    Logger.log("[Step 5/7] Computing and persisting daily metrics...");
    report.steps.metrics = MetricSnapshotService.computeAndPersistDailyMetrics();

    // Step 6: Compute and Persist Daily Alerts
    Logger.log("[Step 6/7] Computing and persisting daily alerts...");
    report.steps.alerts = MetricSnapshotService.computeAndPersistAlerts();

    // Step 7: Send Email Alerts
    Logger.log("[Step 7/7] Sending daily alert digest...");
    var settings = SettingsService.getSettings();
    if (settings.notifications.send_daily_summary) {
      report.steps.email = { success: MailService.sendDailyAlertsDigest(), message: "Email digest sent." };
    } else {
      report.steps.email = { success: true, message: "Email notifications disabled in settings." };
    }

    // Determine overall success (Steps 1-3 and 5-6 are critical; Step 4 is best-effort)
    report.overall_success =
      report.steps.catalog.success &&
      report.steps.metrics.success;

  } catch(err) {
    Logger.log("Pipeline fatal error: " + err.toString());
    report.steps.fatal_error = { success: false, message: err.toString() };
    report.overall_success = false;
  }

  report.completed_at = new Date().toISOString();
  return report;
}

// ═══════════════════════════════════════════════════════════════
// TRIGGER MANAGEMENT
// ═══════════════════════════════════════════════════════════════

/**
 * Install the daily time-driven trigger.
 * Runs scheduledDailyJobTrigger() every day at 8 AM (WAT / GMT+1).
 * Safe to call multiple times — removes existing daily triggers first.
 */
function installDailyTrigger() {
  // Remove existing daily triggers to avoid duplicates
  uninstallTriggers_("scheduledDailyJobTrigger");

  ScriptApp.newTrigger("scheduledDailyJobTrigger")
    .timeBased()
    .everyDays(1)
    .atHour(8)     // 8 AM in the script's timezone
    .nearMinute(0)
    .create();

  Logger.log("Daily trigger installed: scheduledDailyJobTrigger at 8:00 AM.");
  return { success: true, message: "Daily trigger installed for 8:00 AM." };
}

/**
 * Remove all project triggers (use with caution).
 */
function uninstallAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    ScriptApp.deleteTrigger(triggers[i]);
  }
  Logger.log("All " + triggers.length + " project triggers removed.");
  return { success: true, message: "Removed " + triggers.length + " triggers." };
}

/**
 * Remove triggers for a specific function only.
 * @param {string} functionName - The function name to remove triggers for.
 * @private
 */
function uninstallTriggers_(functionName) {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === functionName) {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  if (removed > 0) {
    Logger.log("Removed " + removed + " existing trigger(s) for '" + functionName + "'.");
  }
}

/**
 * List all active triggers (for debugging).
 */
function listTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var list = triggers.map(function(t) {
    return {
      function_name: t.getHandlerFunction(),
      type: t.getEventType().toString(),
      trigger_id: t.getUniqueId()
    };
  });
  Logger.log("Active triggers: " + JSON.stringify(list));
  return list;
}

// ═══════════════════════════════════════════════════════════════
// HELPER: Compute Summary/Health from Product Array
// (Avoids re-querying BigQuery when we already have the data)
// ═══════════════════════════════════════════════════════════════

/**
 * Compute dashboard summary cards from a pre-fetched product array.
 */
function computeSummaryFromProducts(data) {
  var totalRevenue = 0;
  var totalCost = 0;
  var revenueAtRisk = 0;
  var marginLeakage = 0;
  var opportunityTotal = 0;

  var greenCount = 0;
  var yellowCount = 0;
  var orangeCount = 0;
  var redCount = 0;

  data.forEach(function(p) {
    totalRevenue += (parseFloat(p.revenue_latest) || 0);
    totalCost += ((parseFloat(p.cost_price_today) || 0) * (parseFloat(p.quantity_sold_latest) || 0));
    revenueAtRisk += (parseFloat(p.revenue_at_risk) || 0);
    marginLeakage += (parseFloat(p.margin_leakage) || 0);

    if ((parseFloat(p.opportunity_score) || 0) > 50) {
      opportunityTotal += ((parseFloat(p.market_median_price) || 0) - (parseFloat(p.selling_price_today) || 0)) * (parseFloat(p.quantity_sold_latest) || 0);
    }

    var rs = parseFloat(p.risk_score) || 0;
    if (rs <= 30) greenCount++;
    else if (rs <= 60) yellowCount++;
    else if (rs <= 80) orangeCount++;
    else redCount++;
  });

  var grossProfit = totalRevenue - totalCost;
  var overallMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) : 0;

  return {
    total_revenue: totalRevenue,
    gross_profit: grossProfit,
    overall_margin: overallMargin,
    revenue_at_risk: revenueAtRisk,
    margin_leakage: marginLeakage,
    opportunity_value: Math.max(0, opportunityTotal),
    alerts: {
      green: greenCount,
      yellow: yellowCount,
      orange: orangeCount,
      red: redCount,
      critical: redCount + orangeCount
    }
  };
}

/**
 * Compute supplier health scorecards from a pre-fetched product array.
 */
function computeSupplierHealthFromProducts(data) {
  var supplierMap = {};

  data.forEach(function(p) {
    var s = p.supplier_name || "Unknown Supplier";
    if (!supplierMap[s]) {
      supplierMap[s] = { name: s, count: 0, revenue: 0, profit: 0, totalRisk: 0 };
    }
    supplierMap[s].count++;
    supplierMap[s].revenue += (parseFloat(p.revenue_latest) || 0);
    supplierMap[s].profit += (parseFloat(p.gross_profit_latest) || 0);
    supplierMap[s].totalRisk += (parseFloat(p.risk_score) || 0);
  });

  return Object.keys(supplierMap).map(function(k) {
    var s = supplierMap[k];
    return {
      supplier_name: s.name,
      product_count: s.count,
      revenue: s.revenue,
      margin_pct: s.revenue > 0 ? (s.profit / s.revenue) : 0,
      health_score: Math.max(0, 100 - Math.round(s.totalRisk / s.count))
    };
  }).sort(function(a, b) { return a.health_score - b.health_score; });
}

/**
 * Compute category health scorecards from a pre-fetched product array.
 */
function computeCategoryHealthFromProducts(data) {
  var categoryMap = {};

  data.forEach(function(p) {
    var c = p.category_level_1 || "Uncategorized";
    if (!categoryMap[c]) {
      categoryMap[c] = { name: c, count: 0, revenue: 0, profit: 0, totalRisk: 0 };
    }
    categoryMap[c].count++;
    categoryMap[c].revenue += (parseFloat(p.revenue_latest) || 0);
    categoryMap[c].profit += (parseFloat(p.gross_profit_latest) || 0);
    categoryMap[c].totalRisk += (parseFloat(p.risk_score) || 0);
  });

  return Object.keys(categoryMap).map(function(k) {
    var c = categoryMap[k];
    return {
      category_name: c.name,
      product_count: c.count,
      revenue: c.revenue,
      margin_pct: c.revenue > 0 ? (c.profit / c.revenue) : 0,
      health_score: Math.max(0, 100 - Math.round(c.totalRisk / c.count))
    };
  }).sort(function(a, b) { return a.health_score - b.health_score; });
}
