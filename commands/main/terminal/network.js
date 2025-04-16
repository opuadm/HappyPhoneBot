/**
 * Network simulation system for terminal operations
 */
const { loadFromDB, saveToDB } = require("../../../db/utils");

// Default network configuration
const DEFAULT_CONFIG = {
  speed: 500, // Mbps
  latency: 20, // ms
  packetLoss: 0, // percentage
  jitter: 0, // ms
  enabled: true,
};

// Package sizes in KB
const PACKAGE_SIZES = {
  echo: 472,
  edit: 8400,
  test: 407,
  "edit-file": 8400,
  happyphone: 413,
};

// In-memory cache of network configurations
let networkConfigsCache = new Map();

/**
 * Initialize or get network configuration for a user
 * @param {string} userId - User ID
 * @returns {Object} - User's network configuration
 */
async function getUserNetworkConfig(userId) {
  // Check cache first
  if (!networkConfigsCache.has(userId)) {
    // Load from database or use default
    const networkConfig = await loadFromDB("user_network_configs", userId, { ...DEFAULT_CONFIG });
    networkConfigsCache.set(userId, networkConfig);
  }
  return networkConfigsCache.get(userId);
}

/**
 * Save network configuration for a user
 * @param {string} userId - User ID
 * @param {Object} config - Network configuration
 */
async function saveUserNetworkConfig(userId, config) {
  // Update cache
  networkConfigsCache.set(userId, config);
  // Save to database
  await saveToDB("user_network_configs", userId, config);
}

/**
 * Calculate download time for a package based on network speed
 * @param {string} userId - User ID
 * @param {string} packageName - Package name
 * @param {number} packageSizeKB - Size of package in KB
 * @returns {Object} - Download time details
 */
async function calculateDownloadTime(userId, packageName, packageSizeKB) {
  const config = await getUserNetworkConfig(userId);
  const packageSize = packageSizeKB || PACKAGE_SIZES[packageName] || 1024; // Default to 1MB if not specified

  if (!config.enabled) {
    return { time: 0, size: packageSize };
  }

  // IMPORTANT CORRECTION:
  // packageSize is in KiloBytes (KB)
  // Network speeds are measured in bits per second (bps)
  // 1 Byte = 8 bits, so 1 KB = 8 Kb (kilobits)
  
  // Convert KB to bits (multiply by 8 * 1024)
  const sizeInBits = packageSize * 8 * 1024;
  
  // Network speed in Mbps (config.speed) converted to bits per second
  const speedInBitsPerSec = config.speed * 1000000; // Mbps to bps
  
  // Calculate time in seconds (size in bits / speed in bits per second)
  let downloadTimeSeconds = sizeInBits / speedInBitsPerSec;
  
  // Convert to milliseconds
  let downloadTime = downloadTimeSeconds * 1000;
  
  // For simulation purposes, enforce minimum download time based on package size
  // Even small packages should take some time to download for better user experience
  const minTime = Math.min(1000, packageSize); // At least 1ms per KB up to 1 second
  downloadTime = Math.max(minTime, downloadTime);
  
  // Add network conditions
  downloadTime += config.latency;

  // Add random jitter
  if (config.jitter > 0) {
    const jitterAmount = Math.random() * config.jitter;
    downloadTime += jitterAmount;
  }

  // Account for packet loss by increasing time
  if (config.packetLoss > 0) {
    const packetLossFactor = 1 + config.packetLoss / 100;
    downloadTime *= packetLossFactor;
  }

  // Round to whole number of ms for display
  return {
    time: Math.round(downloadTime),
    size: packageSize,
  };
}

/**
 * Create download steps that update every 1.5 seconds showing real progress
 */
async function createDownloadSteps(userId, packageName, packageSizeKB) {
  const size = packageSizeKB || PACKAGE_SIZES[packageName] || 1024;
  const { time } = await calculateDownloadTime(userId, packageName, size);
  const config = await getUserNetworkConfig(userId);

  // If simulation disabled, one instant step
  if (!config.enabled) {
    return [{
      progress: 100,
      message: `Downloaded ${formatSize(size)} instantly`,
      wait: 0,
      complete: true
    }];
  }

  const interval = 1500; // ms
  const numUpdates = Math.ceil(time / interval);
  const steps = [];

  for (let i = 1; i <= numUpdates; i++) {
    const isLast = i === numUpdates;
    const wait = isLast
      ? Math.max(50, time - interval * (numUpdates - 1))
      : interval;

    const elapsed = Math.min(time, i * interval);
    const progress = Math.round((elapsed / time) * 100 * 10) / 10; // one decimal

    const downloaded = (size * elapsed) / time;
    const message = isLast
      ? `Downloaded ${formatSize(size)} in ${formatTime(time)}`
      : `Downloading ${packageName}... ${progress.toFixed(1)}% (${formatSize(downloaded)}/${formatSize(size)})`;

    steps.push({
      progress: isLast ? 100 : progress,
      message,
      wait,
      complete: isLast
    });
  }

  return steps;
}

/**
 * Recalculate download steps based on new network settings
 * @param {string} userId - User ID
 * @param {string} packageName - Package name
 * @param {Object} downloadState - Current download state
 * @returns {Object} - Updated download state with recalculated timings
 */
async function recalculateDownloadSteps(userId, packageName, downloadState) {
  // If download is complete or not started, no need to recalculate
  if (!downloadState || downloadState.currentStep >= downloadState.steps.length) {
    return downloadState;
  }
  
  const { time, size } = await calculateDownloadTime(userId, packageName);
  const config = await getUserNetworkConfig(userId);
  
  // For instant downloads or disabled network sim, complete immediately
  if (time === 0 || !config.enabled || time < 100) {
    downloadState.currentStep = downloadState.steps.length - 1;
    return downloadState;
  }
  
  // Calculate how much has been downloaded so far
  const currentProgress = downloadState.steps[downloadState.currentStep].progress;
  const downloadedAmount = (size * currentProgress) / 100;
  const remainingSize = size - downloadedAmount;
  
  // Calculate time for remaining download based on new speed
  // CORRECTED: Convert KB to bits properly
  const remainingSizeInBits = remainingSize * 8 * 1024; // KB to bits
  const speedInBitsPerSec = config.speed * 1000000; // Mbps to bps
  const remainingTimeSeconds = remainingSizeInBits / speedInBitsPerSec;
  const remainingTimeMs = Math.max(100, remainingTimeSeconds * 1000);
  
  // Calculate how many updates we'll show based on remaining download time
  const updateInterval = 1500; // ms
  const numUpdates = Math.max(1, Math.ceil(remainingTimeMs / updateInterval));
  
  // Calculate new bytes per ms throughput
  const bytesPerMs = remainingSize / remainingTimeMs;
  
  // Create new steps starting from current progress
  const newSteps = [];
  for (let i = 0; i < numUpdates; i++) {
    const isComplete = i === numUpdates - 1;
    
    // Calculate wait time
    const waitTime = isComplete ?
      Math.max(500, remainingTimeMs - (i * updateInterval)) : // Final step takes remaining time
      updateInterval * (0.9 + Math.random() * 0.2); // Regular steps take ~1.5s with variation
      
    // Calculate how much more will be downloaded by this step
    const elapsedTime = i * updateInterval;
    const additionalDownloaded = isComplete ?
      remainingSize : // Final step completes the download
      Math.min(remainingSize, bytesPerMs * elapsedTime);
    
    const stepDownloadedAmount = downloadedAmount + additionalDownloaded;
    
    // Calculate progress percentage
    const progress = (stepDownloadedAmount / size) * 100;
    
    newSteps.push({
      progress,
      message: isComplete 
        ? `Downloaded ${formatSize(size)} in ${formatTime(time * (currentProgress / 100) + remainingTimeMs)}`
        : `Downloading ${packageName}... ${progress.toFixed(1)}% (${formatSize(stepDownloadedAmount)}/${formatSize(size)})`,
      wait: waitTime,
      complete: isComplete
    });
  }
  
  // Replace remaining steps
  downloadState.steps = [
    ...downloadState.steps.slice(0, downloadState.currentStep + 1),
    ...newSteps
  ];
  
  return downloadState;
}

/**
 * Format size in human-readable format
 * @param {number} sizeKB - Size in KB
 * @returns {string}
 */
function formatSize(sizeKB) {
  const formattedSize = Number.isInteger(sizeKB) ? sizeKB : Number(sizeKB.toFixed(2));
  if (formattedSize < 1024) {
    return `${formattedSize} KB`;
  } else {
    return `${(formattedSize / 1024).toFixed(2)} MB`;
  }
}

/**
 * Format time in appropriate units
 * @param {number} timeMs - Time in milliseconds
 * @returns {string}
 */
function formatTime(timeMs) {
  if (timeMs < 1000) {
    return `${timeMs} ms`;
  } else {
    return `${(timeMs / 1000).toFixed(2)} seconds`;
  }
}

module.exports = {
  calculateDownloadTime,
  createDownloadSteps,
  formatSize,
  formatTime,
  PACKAGE_SIZES,
  getUserNetworkConfig,
  saveUserNetworkConfig,
  recalculateDownloadSteps,
};
