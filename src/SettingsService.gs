/**
 * SettingsService
 * Manages configuration rules, email recipients, and alert thresholds.
 */
var SettingsService = (function() {

  var DEFAULT_SETTINGS = {
    thresholds: {
      price_spike_warning: 0.20,
      price_spike_high: 0.40,
      price_spike_critical: 0.70,
      
      cost_spike_warning: 0.20,
      cost_spike_high: 0.40,
      cost_spike_critical: 0.70,
      
      competitor_premium_warning: 0.25,
      competitor_premium_high: 0.50,
      competitor_premium_critical: 1.00
    },
    notifications: {
      email_recipients: "pricing-alerts@company.com",
      slack_webhook: "",
      send_daily_summary: true
    },
    github: {
      pat: "",
      repo: "owner/price-guard-pipeline"
    },
    competitors: {
      mano: true,
      chowstore: true,
      spar: true,
      supersaver: true
    }
  };

  /**
   * Get all active configurations.
   */
  function getSettings() {
    var props = PropertiesService.getScriptProperties();
    var saved = props.getProperty("SYSTEM_SETTINGS");
    if (!saved) {
      return DEFAULT_SETTINGS;
    }
    
    try {
      var parsed = JSON.parse(saved);
      // Merge with defaults to ensure completeness
      return mergeDeep(DEFAULT_SETTINGS, parsed);
    } catch(e) {
      return DEFAULT_SETTINGS;
    }
  }

  /**
   * Save configuration object.
   */
  function saveSettings(settings) {
    var props = PropertiesService.getScriptProperties();
    props.setProperty("SYSTEM_SETTINGS", JSON.stringify(settings));
    return true;
  }

  // Helper utility for deep merge
  function mergeDeep(target, source) {
    var output = Object.assign({}, target);
    if (isObject(target) && isObject(source)) {
      Object.keys(source).forEach(function(key) {
        if (isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, defineProperty({}, key, source[key]));
          } else {
            output[key] = mergeDeep(target[key], source[key]);
          }
        } else {
          Object.assign(output, defineProperty({}, key, source[key]));
        }
      });
    }
    return output;
  }

  function isObject(item) {
    return (item && typeof item === 'object' && !Array.isArray(item));
  }

  function defineProperty(obj, key, value) {
    obj[key] = value;
    return obj;
  }

  return {
    getSettings: getSettings,
    saveSettings: saveSettings
  };
})();
