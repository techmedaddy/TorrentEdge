/**
 * SpeedTracker - Calculates smoothed speed using exponential moving average
 * 
 * Used for calculating download/upload speeds with smoothing to avoid
 * jumpy speed displays in the UI.
 */
class SpeedTracker {
  /**
   * @param {number} windowMs - Time window for speed calculation (default 5 seconds)
   */
  constructor(windowMs = 5000) {
    this.windowMs = windowMs;
    this.samples = [];
    this.lastUpdate = Date.now();
  }
  
  /**
   * Add bytes transferred
   * @param {number} bytes - Number of bytes transferred
   */
  addBytes(bytes) {
    const now = Date.now();
    this.samples.push({
      bytes,
      timestamp: now
    });
    
    // Remove old samples outside the window
    const cutoff = now - this.windowMs;
    this.samples = this.samples.filter(s => s.timestamp >= cutoff);
    
    this.lastUpdate = now;
  }
  
  /**
   * Get current speed in bytes per second
   * @returns {number} Speed in bytes/second
   */
  getSpeed() {
    if (this.samples.length === 0) {
      return 0;
    }
    
    // Calculate speed over the window
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const recentSamples = this.samples.filter(s => s.timestamp >= cutoff);
    
    if (recentSamples.length === 0) {
      return 0;
    }
    
    const totalBytes = recentSamples.reduce((sum, s) => sum + s.bytes, 0);
    const oldestTimestamp = recentSamples[0].timestamp;
    const duration = (now - oldestTimestamp) / 1000;
    
    return duration > 0 ? totalBytes / duration : 0;
  }
  
  /**
   * Reset all samples
   */
  reset() {
    this.samples = [];
    this.lastUpdate = Date.now();
  }
  
  /**
   * Get time since last update
   * @returns {number} Milliseconds since last update
   */
  getIdleTime() {
    return Date.now() - this.lastUpdate;
  }
  
  /**
   * Check if tracker has recent activity
   * @param {number} thresholdMs - Threshold in milliseconds
   * @returns {boolean}
   */
  isActive(thresholdMs = 5000) {
    return this.getIdleTime() < thresholdMs;
  }
}

module.exports = { SpeedTracker };
