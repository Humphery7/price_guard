/**
 * MailService
 * Handles construction and dispatch of HTML-formatted email alerts.
 */
var MailService = (function() {

  /**
   * Run anomaly scan and email summary to stakeholders.
   */
  function sendDailyAlertsDigest() {
    var settings = SettingsService.getSettings();
    var alerts = AnomalyService.detectAlerts();
    
    if (alerts.length === 0) {
      Logger.log("No anomalies detected today. Skipping email alert.");
      return false;
    }
    
    var recipients = settings.notifications.email_recipients;
    if (!recipients) {
      Logger.log("No email recipients configured. Alert skipped.");
      return false;
    }
    
    var htmlBody = buildHtmlBody(alerts);
    
    GmailApp.sendEmail(recipients, "Price Guard – Daily Pricing Alerts Summary", "", {
      htmlBody: htmlBody
    });
    
    Logger.log("Sent daily anomaly digest to: " + recipients);
    return true;
  }

  function buildHtmlBody(alerts) {
    var criticalCount = alerts.filter(function(a) { return a.severity === 'critical'; }).length;
    var highCount = alerts.filter(function(a) { return a.severity === 'high'; }).length;
    var warningCount = alerts.filter(function(a) { return a.severity === 'warning'; }).length;

    var html = '<div style="font-family: \'Segoe UI\', Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #2D3748; line-height: 1.6;">';
    
    // Header
    html += '<div style="background: linear-gradient(135deg, #1A365D 0%, #2A4365 100%); padding: 30px; border-radius: 8px 8px 0 0; text-align: center;">' +
            '<h1 style="color: #ffffff; margin: 0; font-size: 24px; font-weight: 600; letter-spacing: 0.5px;">Price Guard Alerts</h1>' +
            '<p style="color: #E2E8F0; margin: 5px 0 0 0; font-size: 14px;">Daily Pricing Intelligence Summary</p>' +
            '</div>';
            
    // Alert Stats
    html += '<div style="background: #F7FAFC; border: 1px solid #E2E8F0; padding: 20px; border-top: none; text-align: center;">' +
            '<div style="display: inline-block; margin: 0 15px;">' +
            '<span style="display: block; font-size: 24px; font-weight: bold; color: #E53E3E;">' + criticalCount + '</span>' +
            '<span style="font-size: 12px; color: #718096; text-transform: uppercase;">Critical</span>' +
            '</div>' +
            '<div style="display: inline-block; margin: 0 15px;">' +
            '<span style="display: block; font-size: 24px; font-weight: bold; color: #DD6B20;">' + highCount + '</span>' +
            '<span style="font-size: 12px; color: #718096; text-transform: uppercase;">High</span>' +
            '</div>' +
            '<div style="display: inline-block; margin: 0 15px;">' +
            '<span style="display: block; font-size: 24px; font-weight: bold; color: #D69E2E;">' + warningCount + '</span>' +
            '<span style="font-size: 12px; color: #718096; text-transform: uppercase;">Warning</span>' +
            '</div>' +
            '</div>';

    // Alerts Table
    html += '<div style="padding: 20px 0;">' +
            '<h2 style="font-size: 16px; font-weight: 600; margin-bottom: 15px; color: #1A365D;">Active Anomalies</h2>' +
            '<table style="width: 100%; border-collapse: collapse; font-size: 14px;">' +
            '<thead>' +
            '<tr style="border-bottom: 2px solid #E2E8F0; text-align: left;">' +
            '<th style="padding: 10px; font-weight: 600;">Product / SKU</th>' +
            '<th style="padding: 10px; font-weight: 600;">Alert Type</th>' +
            '<th style="padding: 10px; font-weight: 600;">Severity</th>' +
            '</tr>' +
            '</thead>' +
            '<tbody>';
            
    alerts.forEach(function(a) {
      var sevColor = "#E53E3E"; // critical
      if (a.severity === "high") sevColor = "#DD6B20";
      else if (a.severity === "warning") sevColor = "#D69E2E";

      html += '<tr style="border-bottom: 1px solid #EDF2F7;">' +
              '<td style="padding: 12px 10px;">' +
              '<span style="font-weight: 500; display: block;">' + a.product_name + '</span>' +
              '<span style="font-size: 11px; color: #718096; display: block;">SKU: ' + a.product_sku + '</span>' +
              '</td>' +
              '<td style="padding: 12px 10px;">' +
              '<span style="font-weight: 500;">' + a.alert_type + '</span>' +
              '<span style="font-size: 11px; color: #718096; display: block;">' + a.details + '</span>' +
              '</td>' +
              '<td style="padding: 12px 10px;">' +
              '<span style="background-color: ' + sevColor + '20; color: ' + sevColor + '; padding: 3px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; text-transform: uppercase;">' + a.severity + '</span>' +
              '</td>' +
              '</tr>';
    });
    
    html += '</tbody></table></div>';
    
    // Call to Action / Footer
    html += '<div style="margin-top: 20px; padding: 20px; background-color: #F7FAFC; border-radius: 6px; text-align: center; border: 1px solid #E2E8F0;">' +
            '<p style="font-size: 13px; color: #4A5568; margin-top: 0;">Please visit the Price Guard platform to manage pricing anomalies and approve changes.</p>' +
            '<a href="' + ScriptApp.getService().getUrl() + '" style="display: inline-block; background-color: #3182CE; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; font-weight: 600; font-size: 14px;">Open Dashboard</a>' +
            '</div>';
            
    html += '<div style="margin-top: 30px; text-align: center; font-size: 11px; color: #A0AEC0;">' +
            '<p>Price Guard Intelligence Portal. Generated automatically.</p>' +
            '</div></div>';
            
    return html;
  }

  return {
    sendDailyAlertsDigest: sendDailyAlertsDigest
  };
})();
