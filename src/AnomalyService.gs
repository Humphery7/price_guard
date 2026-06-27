/**
 * AnomalyService
 * Scans products and computes specific rule-based alerts.
 */
var AnomalyService = (function() {

  /**
   * Main scan function to detect alerts across all product logs.
   */
  function detectAlerts() {
    var products = MetricService.getComputedData();
    var alerts = [];

    // Load active settings thresholds or fallback to defaults
    var settings = SettingsService.getSettings();

    products.forEach(function(p) {
      // 1. Check Cost Price Spike
      if (p.cost_price_today > 0 && p.cost_price_last_month > 0) {
        var costChange = (p.cost_price_today - p.cost_price_last_month) / p.cost_price_last_month;
        if (costChange >= settings.thresholds.cost_spike_critical) {
          alerts.push(createAlert(p, "Cost Spike", "Critical cost increase of " + Math.round(costChange * 100) + "% MoM.", "critical"));
        } else if (costChange >= settings.thresholds.cost_spike_high) {
          alerts.push(createAlert(p, "Cost Spike", "High cost increase of " + Math.round(costChange * 100) + "% MoM.", "high"));
        } else if (costChange >= settings.thresholds.cost_spike_warning) {
          alerts.push(createAlert(p, "Cost Spike", "Cost increase of " + Math.round(costChange * 100) + "% MoM.", "warning"));
        }
      }

      // 2. Check Selling Price Spike
      if (p.selling_price_today > 0 && p.selling_price_last_month > 0) {
        var spChange = (p.selling_price_today - p.selling_price_last_month) / p.selling_price_last_month;
        if (spChange >= settings.thresholds.price_spike_critical) {
          alerts.push(createAlert(p, "Price Spike", "Critical price increase of " + Math.round(spChange * 100) + "% MoM.", "critical"));
        } else if (spChange >= settings.thresholds.price_spike_high) {
          alerts.push(createAlert(p, "Price Spike", "High price increase of " + Math.round(spChange * 100) + "% MoM.", "high"));
        } else if (spChange >= settings.thresholds.price_spike_warning) {
          alerts.push(createAlert(p, "Price Spike", "Price increase of " + Math.round(spChange * 100) + "% MoM.", "warning"));
        }
      }

      // 3. Check Competitor Premium Gap
      if (p.market_median_price > 0) {
        var premium = (p.selling_price_today - p.market_median_price) / p.market_median_price;
        if (premium >= settings.thresholds.competitor_premium_critical) {
          alerts.push(createAlert(p, "Competitor Premium", "Priced " + Math.round(premium * 100) + "% higher than market median (Critical).", "critical"));
        } else if (premium >= settings.thresholds.competitor_premium_high) {
          alerts.push(createAlert(p, "Competitor Premium", "Priced " + Math.round(premium * 100) + "% higher than market median (High).", "high"));
        } else if (premium >= settings.thresholds.competitor_premium_warning) {
          alerts.push(createAlert(p, "Competitor Premium", "Priced " + Math.round(premium * 100) + "% higher than market median (Warning).", "warning"));
        }
      }

      // 4. Check Margin Leakage (Direct Loss)
      if (p.selling_price_today < p.cost_price_today) {
        alerts.push(createAlert(p, "Negative Margin", "Selling price is below cost (leakage: ₦" + (p.cost_price_today - p.selling_price_today) + " per unit).", "critical"));
      } else if (p.margin_today < p.margin_last_month - 0.10) {
        alerts.push(createAlert(p, "Margin Degradation", "Margin dropped by " + Math.round((p.margin_last_month - p.margin_today) * 100) + "% vs last month.", "high"));
      }
    });

    return alerts;
  }

  function createAlert(product, type, details, severity) {
    return {
      product_sku: product.product_sku,
      product_name: product.product_name,
      alert_type: type,
      details: details,
      severity: severity,
      revenue_latest: product.revenue_latest,
      timestamp: new Date().toISOString()
    };
  }

  return {
    detectAlerts: detectAlerts
  };
})();
