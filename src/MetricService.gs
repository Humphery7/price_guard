/**
 * MetricService
 * Computes margin, revenue, competitive, and health metrics dynamically.
 * 
 * Used by the daily pipeline (via MetricSnapshotService) to compute and persist metrics.
 * Also used as a fallback when no precomputed snapshot exists.
 * 
 * Includes an in-memory CacheService wrapper to avoid redundant BigQuery calls
 * within the same Apps Script execution context.
 */
var MetricService = (function() {

  // ─────────────────────────────────────────────────────────────
  // In-Memory Cache (per-execution context)
  // ─────────────────────────────────────────────────────────────

  var CACHE_KEY = "METRIC_SERVICE_COMPUTED_DATA";
  var CACHE_TTL_SECONDS = 600; // 10 minutes

  /**
   * Try reading from Apps Script CacheService.
   * Returns null if cache miss or expired.
   */
  function getCachedData() {
    try {
      var cache = CacheService.getScriptCache();
      var cached = cache.get(CACHE_KEY);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch(e) {
      // Cache read failed — compute fresh
    }
    return null;
  }

  /**
   * Write computed data to Apps Script CacheService.
   */
  function setCachedData(data) {
    try {
      var cache = CacheService.getScriptCache();
      var serialized = JSON.stringify(data);
      // CacheService has a 100KB limit per key. If data is too large, skip caching.
      if (serialized.length < 100000) {
        cache.put(CACHE_KEY, serialized, CACHE_TTL_SECONDS);
      }
    } catch(e) {
      // Cache write failed — not critical
    }
  }

  /**
   * Invalidate cached data. Call after manual overrides or rematches.
   */
  function invalidateCache() {
    try {
      var cache = CacheService.getScriptCache();
      cache.remove(CACHE_KEY);
    } catch(e) {
      // Non-critical
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Core Computation
  // ─────────────────────────────────────────────────────────────

  /**
   * Main calculation function to fetch product records, append competitor details, 
   * and calculate metrics for dashboard consumption.
   * Results are cached for 10 minutes to avoid redundant BigQuery calls.
   */
  function getComputedData() {
    // Check cache first
    var cached = getCachedData();
    if (cached) {
      return cached;
    }

    var products = BigQueryService.query("SELECT * FROM internal_products");
    var matches = BigQueryService.query("SELECT * FROM product_matches WHERE is_approved = true");
    
    // Index matches by product_sku
    var matchesBySku = {};
    matches.forEach(function(m) {
      if (!matchesBySku[m.product_sku]) {
        matchesBySku[m.product_sku] = [];
      }
      matchesBySku[m.product_sku].push(m);
    });

    var computedProducts = products.map(function(p) {
      var sku = p.product_sku;
      var skuMatches = matchesBySku[sku] || [];
      
      // Ensure numeric types (BigQuery may return strings)
      var spToday = parseFloat(p.selling_price_today) || 0;
      var cpToday = parseFloat(p.cost_price_today) || 0;
      var spLastMonth = parseFloat(p.selling_price_last_month) || 0;
      var cpLastMonth = parseFloat(p.cost_price_last_month) || 0;
      var spLast2Months = parseFloat(p.selling_price_last_2_months) || 0;
      var cpLast2Months = parseFloat(p.cost_price_last_2_months) || 0;
      var qtySold = parseFloat(p.quantity_sold_latest) || 0;
      var revLatest = parseFloat(p.revenue_latest) || 0;
      var qtyLastMonth = parseFloat(p.quantity_sold_last_month) || 0;

      // Calculate Market Prices
      var compPrices = skuMatches.map(function(m) { return parseFloat(m.latest_price) || 0; }).filter(function(v) { return v > 0; });
      var marketMedian = calculateMedian(compPrices);
      
      // Basic margins
      var marginToday = spToday > 0 ? (spToday - cpToday) / spToday : 0;
      var marginLastMonth = spLastMonth > 0 ? (spLastMonth - cpLastMonth) / spLastMonth : 0;
      var marginLast2Months = spLast2Months > 0 ? (spLast2Months - cpLast2Months) / spLast2Months : 0;
      
      // Gross Profits
      var gpLatest = (spToday - cpToday) * qtySold;
      var gpLastMonth = (spLastMonth - cpLastMonth) * qtyLastMonth;
      
      // Competitive metrics
      var priceIndex = marketMedian > 0 ? (spToday / marketMedian) * 100 : 100;
      var competitorGap = marketMedian > 0 ? (spToday - marketMedian) : 0;
      
      // Business Impact metrics
      var revenueAtRisk = 0;
      if (priceIndex > 120 && revLatest > 0) {
        revenueAtRisk = revLatest;
      }
      
      var marginLeakage = 0;
      if (spToday < cpToday) {
        marginLeakage = (cpToday - spToday) * qtySold;
      } else if (priceIndex < 85 && marketMedian > 0) {
        marginLeakage = (marketMedian - spToday) * qtySold;
      }
      
      var opportunityScore = 0;
      if (priceIndex < 90 && marketMedian > 0 && qtySold > 0) {
        opportunityScore = Math.min(100, Math.round(((marketMedian - spToday) * qtySold) / 1000));
      }

      // Risk score: scales from 0 to 100
      var riskScore = calculateProductRiskScore({
        selling_price_today: spToday,
        cost_price_today: cpToday,
        selling_price_last_month: spLastMonth,
        cost_price_last_month: cpLastMonth,
        revenue_latest: revLatest
      }, priceIndex);

      return {
        product_sku: sku,
        product_name: p.product_name,
        supplier_name: p.supplier_name,
        category_level_1: p.product_category_level_one,
        category_level_2: p.product_category_level_two,
        category_level_3: p.product_category_level_three,
        
        selling_price_today: spToday,
        cost_price_today: cpToday,
        selling_price_last_month: spLastMonth,
        cost_price_last_month: cpLastMonth,
        margin_today: marginToday,
        margin_last_month: marginLastMonth,
        margin_last_2_months: marginLast2Months,
        
        quantity_sold_latest: qtySold,
        revenue_latest: revLatest,
        gross_profit_latest: gpLatest,
        gross_profit_last_month: gpLastMonth,
        
        market_median_price: marketMedian,
        price_index: priceIndex,
        competitor_gap: competitorGap,
        competitor_count: skuMatches.length,
        
        revenue_at_risk: revenueAtRisk,
        margin_leakage: marginLeakage,
        opportunity_score: opportunityScore,
        risk_score: riskScore
      };
    });
    
    // Cache the computed data
    setCachedData(computedProducts);

    return computedProducts;
  }

  /**
   * Helper logic to get median price.
   */
  function calculateMedian(arr) {
    if (arr.length === 0) return 0;
    var sorted = arr.slice().sort(function(a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 !== 0) {
      return sorted[mid];
    }
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * Calculate Risk Score based on requirements:
   * Price increases, cost price increases, margin drops, uncompetitiveness, revenue importance.
   */
  function calculateProductRiskScore(p, priceIndex) {
    var score = 0;
    
    // 1. Cost spike check
    if (p.cost_price_last_month > 0) {
      var costChange = (p.cost_price_today - p.cost_price_last_month) / p.cost_price_last_month;
      if (costChange > 0.40) score += 35; // Critical cost increase
      else if (costChange > 0.20) score += 15; // Warning cost increase
    }

    // 2. Selling Price spike check
    if (p.selling_price_last_month > 0) {
      var spChange = (p.selling_price_today - p.selling_price_last_month) / p.selling_price_last_month;
      if (spChange > 0.40) score += 35;
      else if (spChange > 0.20) score += 15;
    }

    // 3. Margin degradation
    var marginToday = p.selling_price_today > 0 ? (p.selling_price_today - p.cost_price_today) / p.selling_price_today : 0;
    var marginLast = p.selling_price_last_month > 0 ? (p.selling_price_last_month - p.cost_price_last_month) / p.selling_price_last_month : 0;
    if (marginToday < 0) score += 40; // Negative margin
    else if (marginToday < marginLast - 0.05) score += 20; // Margin dropped > 5%

    // 4. Competitor price difference (Overpriced risk)
    if (priceIndex > 140) score += 30;
    else if (priceIndex > 120) score += 15;

    // 5. Volume weight (Revenue importance weight multiplier)
    var importanceMultiplier = 1.0;
    if (p.revenue_latest > 500000) {
      importanceMultiplier = 1.25; // Critical product
    }
    
    return Math.min(100, Math.round(score * importanceMultiplier));
  }

  /**
   * Aggregate Metrics for the Dashboard page.
   * Note: In the new architecture, Code.gs uses computeSummaryFromProducts() instead.
   * This method is preserved for backward compatibility.
   */
  function getDashboardSummary() {
    var data = getComputedData();
    
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
      totalRevenue += p.revenue_latest;
      totalCost += (p.cost_price_today * p.quantity_sold_latest);
      revenueAtRisk += p.revenue_at_risk;
      marginLeakage += p.margin_leakage;
      
      if (p.opportunity_score > 50) {
        opportunityTotal += (p.market_median_price - p.selling_price_today) * p.quantity_sold_latest;
      }
      
      // Risk category distribution
      if (p.risk_score <= 30) greenCount++;
      else if (p.risk_score <= 60) yellowCount++;
      else if (p.risk_score <= 80) orangeCount++;
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
   * Aggregates metrics by supplier
   */
  function getSupplierHealth() {
    var data = getComputedData();
    var supplierMap = {};

    data.forEach(function(p) {
      var s = p.supplier_name || "Unknown Supplier";
      if (!supplierMap[s]) {
        supplierMap[s] = { name: s, count: 0, revenue: 0, profit: 0, totalRisk: 0 };
      }
      supplierMap[s].count++;
      supplierMap[s].revenue += p.revenue_latest;
      supplierMap[s].profit += p.gross_profit_latest;
      supplierMap[s].totalRisk += p.risk_score;
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
   * Aggregates metrics by category level 1
   */
  function getCategoryHealth() {
    var data = getComputedData();
    var categoryMap = {};

    data.forEach(function(p) {
      var c = p.category_level_1 || "Uncategorized";
      if (!categoryMap[c]) {
        categoryMap[c] = { name: c, count: 0, revenue: 0, profit: 0, totalRisk: 0 };
      }
      categoryMap[c].count++;
      categoryMap[c].revenue += p.revenue_latest;
      categoryMap[c].profit += p.gross_profit_latest;
      categoryMap[c].totalRisk += p.risk_score;
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

  return {
    getComputedData: getComputedData,
    getDashboardSummary: getDashboardSummary,
    getSupplierHealth: getSupplierHealth,
    getCategoryHealth: getCategoryHealth,
    invalidateCache: invalidateCache
  };
})();
