/**
 * MetricSnapshotService
 * Precomputes metrics and alerts during the daily pipeline,
 * then writes snapshots to BigQuery tables for fast dashboard loading.
 * 
 * This replaces the pattern of recomputing everything on every page load.
 * The dashboard reads from these precomputed tables instead.
 */
var MetricSnapshotService = (function() {

  // ─────────────────────────────────────────────────────────────
  // Step 1: Compute and Persist Daily Metrics
  // ─────────────────────────────────────────────────────────────

  /**
   * Compute all product metrics and write them to the computed_daily_metrics table.
   * Uses WRITE_TRUNCATE to replace stale data with today's snapshot.
   * @returns {Object} { success: boolean, product_count: number, message: string }
   */
  function computeAndPersistDailyMetrics() {
    Logger.log("MetricSnapshotService: Computing daily metrics...");

    try {
      // Use MetricService to compute the full product dataset with all metrics
      var computedProducts = MetricService.getComputedData();

      if (!computedProducts || computedProducts.length === 0) {
        Logger.log("MetricSnapshotService: No products to persist. Pipeline may have no data.");
        return { success: true, product_count: 0, message: "No products computed." };
      }

      if (!BigQueryService.useBigQuery()) {
        Logger.log("MetricSnapshotService: Not in BigQuery mode. Metrics computed but not persisted.");
        return { success: true, product_count: computedProducts.length, message: "Mock mode — metrics computed in memory only." };
      }

      // Format rows for BigQuery insertion
      var today = Utilities.formatDate(new Date(), "GMT+1", "yyyy-MM-dd");
      var rows = computedProducts.map(function(p) {
        return {
          snapshot_date: today,
          product_sku: p.product_sku || "",
          product_name: p.product_name || "",
          supplier_name: p.supplier_name || "",
          category_level_1: p.category_level_1 || "",
          category_level_2: p.category_level_2 || "",
          category_level_3: p.category_level_3 || "",
          selling_price_today: p.selling_price_today || 0,
          cost_price_today: p.cost_price_today || 0,
          selling_price_last_month: p.selling_price_last_month || 0,
          cost_price_last_month: p.cost_price_last_month || 0,
          margin_today: p.margin_today || 0,
          margin_last_month: p.margin_last_month || 0,
          margin_last_2_months: p.margin_last_2_months || 0,
          quantity_sold_latest: p.quantity_sold_latest || 0,
          revenue_latest: p.revenue_latest || 0,
          gross_profit_latest: p.gross_profit_latest || 0,
          gross_profit_last_month: p.gross_profit_last_month || 0,
          market_median_price: p.market_median_price || 0,
          price_index: p.price_index || 100,
          competitor_gap: p.competitor_gap || 0,
          competitor_count: p.competitor_count || 0,
          revenue_at_risk: p.revenue_at_risk || 0,
          margin_leakage: p.margin_leakage || 0,
          opportunity_score: p.opportunity_score || 0,
          risk_score: p.risk_score || 0
        };
      });

      // Clear today's snapshot and insert fresh data
      var dataset = BigQueryService.getDataset();
      BigQueryService.executeDML(
        "DELETE FROM `" + dataset + ".computed_daily_metrics` WHERE snapshot_date = '" + today + "'"
      );

      var destTable = BigQueryService.getFullTableRef("computed_daily_metrics");
      var success = BigQueryService.insertRows(destTable, rows);

      if (success) {
        Logger.log("MetricSnapshotService: Persisted " + rows.length + " product metrics for " + today + ".");
        return { success: true, product_count: rows.length, message: "Metrics snapshot saved to BigQuery." };
      } else {
        Logger.log("MetricSnapshotService: Failed to persist metrics.");
        return { success: false, product_count: 0, message: "BigQuery insert failed." };
      }
    } catch(err) {
      Logger.log("MetricSnapshotService: Metric computation error: " + err.toString());
      return { success: false, product_count: 0, message: "Error: " + err.toString() };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Step 2: Compute and Persist Daily Alerts
  // ─────────────────────────────────────────────────────────────

  /**
   * Run anomaly detection and write alerts to the daily_alerts table.
   * @returns {Object} { success: boolean, alert_count: number, message: string }
   */
  function computeAndPersistAlerts() {
    Logger.log("MetricSnapshotService: Computing daily alerts...");

    try {
      var alerts = AnomalyService.detectAlerts();

      if (!alerts || alerts.length === 0) {
        Logger.log("MetricSnapshotService: No anomalies detected today.");
        return { success: true, alert_count: 0, message: "No anomalies detected." };
      }

      if (!BigQueryService.useBigQuery()) {
        Logger.log("MetricSnapshotService: Not in BigQuery mode. Alerts computed but not persisted.");
        return { success: true, alert_count: alerts.length, message: "Mock mode — alerts computed in memory only." };
      }

      // Format rows for BigQuery insertion
      var today = Utilities.formatDate(new Date(), "GMT+1", "yyyy-MM-dd");
      var rows = alerts.map(function(a) {
        return {
          snapshot_date: today,
          product_sku: a.product_sku || "",
          product_name: a.product_name || "",
          alert_type: a.alert_type || "",
          details: a.details || "",
          severity: a.severity || "warning",
          revenue_latest: a.revenue_latest || 0,
          created_at: a.timestamp || new Date().toISOString()
        };
      });

      // Clear today's alerts and insert fresh ones
      var dataset = BigQueryService.getDataset();
      BigQueryService.executeDML(
        "DELETE FROM `" + dataset + ".daily_alerts` WHERE snapshot_date = '" + today + "'"
      );

      var destTable = BigQueryService.getFullTableRef("daily_alerts");
      var success = BigQueryService.insertRows(destTable, rows);

      if (success) {
        Logger.log("MetricSnapshotService: Persisted " + rows.length + " alerts for " + today + ".");
        return { success: true, alert_count: rows.length, message: "Alerts snapshot saved to BigQuery." };
      } else {
        Logger.log("MetricSnapshotService: Failed to persist alerts.");
        return { success: false, alert_count: 0, message: "BigQuery insert failed." };
      }
    } catch(err) {
      Logger.log("MetricSnapshotService: Alert computation error: " + err.toString());
      return { success: false, alert_count: 0, message: "Error: " + err.toString() };
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Read Precomputed Snapshots (for dashboard consumption)
  // ─────────────────────────────────────────────────────────────

  /**
   * Read the latest precomputed metrics from BigQuery.
   * Falls back to live computation if no snapshot exists.
   * @returns {Array<Object>} Array of product metric objects.
   */
  function getLatestMetricsSnapshot() {
    if (!BigQueryService.useBigQuery()) {
      // In mock/spreadsheet mode, compute live
      return MetricService.getComputedData();
    }

    try {
      var dataset = BigQueryService.getDataset();
      var results = BigQueryService.query(
        "SELECT * FROM `" + dataset + ".computed_daily_metrics` " +
        "WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM `" + dataset + ".computed_daily_metrics`) " +
        "ORDER BY product_name"
      );

      if (results && results.length > 0) {
        // Cast numeric strings back to numbers
        return results.map(function(r) {
          return {
            product_sku: r.product_sku,
            product_name: r.product_name,
            supplier_name: r.supplier_name,
            category_level_1: r.category_level_1,
            category_level_2: r.category_level_2,
            category_level_3: r.category_level_3,
            selling_price_today: parseFloat(r.selling_price_today) || 0,
            cost_price_today: parseFloat(r.cost_price_today) || 0,
            selling_price_last_month: parseFloat(r.selling_price_last_month) || 0,
            cost_price_last_month: parseFloat(r.cost_price_last_month) || 0,
            margin_today: parseFloat(r.margin_today) || 0,
            margin_last_month: parseFloat(r.margin_last_month) || 0,
            margin_last_2_months: parseFloat(r.margin_last_2_months) || 0,
            quantity_sold_latest: parseFloat(r.quantity_sold_latest) || 0,
            revenue_latest: parseFloat(r.revenue_latest) || 0,
            gross_profit_latest: parseFloat(r.gross_profit_latest) || 0,
            gross_profit_last_month: parseFloat(r.gross_profit_last_month) || 0,
            market_median_price: parseFloat(r.market_median_price) || 0,
            price_index: parseFloat(r.price_index) || 100,
            competitor_gap: parseFloat(r.competitor_gap) || 0,
            competitor_count: parseInt(r.competitor_count) || 0,
            revenue_at_risk: parseFloat(r.revenue_at_risk) || 0,
            margin_leakage: parseFloat(r.margin_leakage) || 0,
            opportunity_score: parseFloat(r.opportunity_score) || 0,
            risk_score: parseFloat(r.risk_score) || 0
          };
        });
      }

      // No snapshot found — fall back to live computation
      Logger.log("MetricSnapshotService: No snapshot found. Falling back to live computation.");
      return MetricService.getComputedData();
    } catch(err) {
      Logger.log("MetricSnapshotService: Snapshot read failed: " + err.toString() + ". Falling back to live.");
      return MetricService.getComputedData();
    }
  }

  /**
   * Read the latest precomputed alerts from BigQuery.
   * Falls back to live detection if no snapshot exists.
   * @returns {Array<Object>} Array of alert objects.
   */
  function getLatestAlertsSnapshot() {
    if (!BigQueryService.useBigQuery()) {
      return AnomalyService.detectAlerts();
    }

    try {
      var dataset = BigQueryService.getDataset();
      var results = BigQueryService.query(
        "SELECT * FROM `" + dataset + ".daily_alerts` " +
        "WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM `" + dataset + ".daily_alerts`) " +
        "ORDER BY CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'warning' THEN 3 ELSE 4 END"
      );

      if (results && results.length > 0) {
        return results.map(function(r) {
          return {
            product_sku: r.product_sku,
            product_name: r.product_name,
            alert_type: r.alert_type,
            details: r.details,
            severity: r.severity,
            revenue_latest: parseFloat(r.revenue_latest) || 0,
            timestamp: r.created_at
          };
        });
      }

      Logger.log("MetricSnapshotService: No alert snapshot found. Falling back to live detection.");
      return AnomalyService.detectAlerts();
    } catch(err) {
      Logger.log("MetricSnapshotService: Alert snapshot read failed: " + err.toString() + ". Falling back to live.");
      return AnomalyService.detectAlerts();
    }
  }

  return {
    computeAndPersistDailyMetrics: computeAndPersistDailyMetrics,
    computeAndPersistAlerts: computeAndPersistAlerts,
    getLatestMetricsSnapshot: getLatestMetricsSnapshot,
    getLatestAlertsSnapshot: getLatestAlertsSnapshot
  };
})();
