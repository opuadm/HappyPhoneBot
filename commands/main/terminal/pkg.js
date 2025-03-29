const fs = require('node:fs');
const path = require('node:path');
const { loadFromDB, saveToDB } = require("../../../db/utils");
const { createFilesystem } = require("./filesystem");
const { createDownloadSteps, formatSize } = require("./network");

// OS version info
const latestOSVersion = "1.0.0.1";
const osBranches = {
  stable: latestOSVersion,
  unstable: "1.0.0.2",
};

// Package definitions and update sizes
let packageDefinitions = {};
const PACKAGE_SIZES = {};
const UPDATE_SIZES = {};

/**
 * Load all packages from the packages directory
 */
function loadPackages() {
  const packagesDir = path.join(__dirname, 'packages');
  
  // Create directory if it doesn't exist
  if (!fs.existsSync(packagesDir)) {
    try {
      fs.mkdirSync(packagesDir, { recursive: true });
      console.log(`Created packages directory at ${packagesDir}`);
    } catch (err) {
      console.error("Error creating packages directory:", err);
    }
    return;
  }
  
  // Read all files in the directory
  const files = fs.readdirSync(packagesDir);
  
  // Process each .js file as a package definition
  files.forEach(file => {
    if (file.endsWith('.js')) {
      try {
        const packagePath = path.join(packagesDir, file);
        // Clear cache to ensure we get fresh data
        delete require.cache[require.resolve(packagePath)];
        
        const packageData = require(packagePath);
        const packageName = packageData.name;
        
        if (packageName) {
          // Store package requirements
          packageDefinitions[packageName] = {
            stable: { minVersion: packageData.minVersion?.stable || "1.0.0" },
            unstable: { minVersion: packageData.minVersion?.unstable || "1.0.0" }
          };
          
          // Store package size
          PACKAGE_SIZES[packageName] = packageData.size || 1024;
          
          // Store package execute function in installable commands
          if (packageData.execute) {
            const commandsModule = require('./commands');
            if (!commandsModule.installableCommands[packageName]) {
              commandsModule.installableCommands[packageName] = {
                execute: packageData.execute
              };
            }
          }
        }
      } catch (err) {
        console.error(`Error loading package file ${file}:`, err);
      }
    }
  });
}

/**
 * Load all updates from the updates directory
 */
function loadUpdates() {
  const updatesDir = path.join(__dirname, 'updates');
  
  // Create directory if it doesn't exist
  if (!fs.existsSync(updatesDir)) {
    try {
      fs.mkdirSync(updatesDir, { recursive: true });
      console.log(`Created updates directory at ${updatesDir}`);
    } catch (err) {
      console.error("Error creating updates directory:", err);
    }
    return;
  }
  
  // Read all files in the directory
  const files = fs.readdirSync(updatesDir);
  
  // Process each .js file as an update definition
  files.forEach(file => {
    if (file.endsWith('.js')) {
      try {
        const updatePath = path.join(updatesDir, file);
        // Clear cache to ensure we get fresh data
        delete require.cache[require.resolve(updatePath)];
        
        const updateData = require(updatePath);
        if (updateData.version && updateData.size) {
          UPDATE_SIZES[updateData.version] = updateData.size;
          
          // Update osBranches if necessary
          if (updateData.branch) {
            osBranches[updateData.branch] = updateData.version;
          }
        }
      } catch (err) {
        console.error(`Error loading update file ${file}:`, err);
      }
    }
  });
}

// Active downloads tracking
const activeDownloads = new Map();

/**
 * Compare two semantic version strings
 * @param {string} version1 - First version to compare
 * @param {string} version2 - Second version to compare
 * @returns {number} -1 if v1<v2, 0 if equal, 1 if v1>v2
 */
function compareVersions(version1, version2) {
  const v1Parts = version1.split(".").map(Number);
  const v2Parts = version2.split(".").map(Number);

  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const v1Part = v1Parts[i] || 0;
    const v2Part = v2Parts[i] || 0;

    if (v1Part > v2Part) return 1;
    if (v1Part < v2Part) return -1;
  }

  return 0;
}

/**
 * Check if a package is available for the current OS version and branch
 * @param {string} packageName - Package to check availability
 * @param {string} osVersion - OS version
 * @param {string} osBranch - OS branch (stable/unstable)
 * @returns {boolean} - Whether package is available
 */
function isPackageAvailable(packageName, osVersion, osBranch) {
  // Reload package definitions to ensure we have the latest
  loadPackages();

  // If package doesn't exist in definitions
  if (!packageDefinitions[packageName]) return false;

  // If package doesn't support this branch
  if (!packageDefinitions[packageName][osBranch]) return false;

  // Check version compatibility
  const minVersion = packageDefinitions[packageName][osBranch].minVersion;
  return compareVersions(osVersion, minVersion) >= 0;
}

/**
 * Check if a package is currently being downloaded
 * @param {string} userId - User ID
 * @param {string} packageName - Package name
 * @returns {Object|null} - Current download state or null
 */
function getDownloadStatus(userId, packageName) {
  const key = `${userId}:${packageName}`;
  return activeDownloads.get(key) || null;
}

/**
 * Set active download for a package
 * @param {string} userId - User ID
 * @param {string} packageName - Package name
 * @param {Object} downloadState - Download state
 */
function setDownloadStatus(userId, packageName, downloadState) {
  const key = `${userId}:${packageName}`;
  if (!downloadState) {
    activeDownloads.delete(key);
  } else {
    activeDownloads.set(key, downloadState);
  }
}

/**
 * Get OS update size based on version
 * @param {string} version - OS version to check
 * @returns {number} - Size of update in KB
 */
function getUpdateSize(version) {
  // Reload updates to ensure we have the latest
  loadUpdates();
  return UPDATE_SIZES[version] || 2048; // Default to 2MB if not defined
}

/**
 * Process the next step in a download
 * @param {string} userId - User ID
 * @param {Object} userFS - User filesystem
 * @param {string} packageName - Package being downloaded
 * @param {boolean} initialRequest - Whether this is the initial download request
 * @returns {string} - Message to display
 */
async function processDownload(userId, userFS, packageName, initialRequest = false) {
  const downloadState = getDownloadStatus(userId, packageName);
  const isUpdate = packageName.startsWith('update-');

  // If a download is already in progress
  if (downloadState) {
    // If we haven't completed all steps
    if (downloadState.currentStep < downloadState.steps.length) {
      const step = downloadState.steps[downloadState.currentStep];

      // For non-initial requests
      if (!initialRequest) {
        const now = Date.now();
        
        // If it's the final step, install the package or apply the update
        if (downloadState.currentStep === downloadState.steps.length - 1) {
          if (isUpdate) {
            // Handle OS update completion
            const targetVersion = downloadState.targetVersion;
            const currentBranch = userFS.fs["/"].children.sys.children.os_branch?.content || "stable";
            
            userFS.fs["/"].children.sys.children.os_version.content = targetVersion;
            
            await saveToDB("user_filesystems", userId, userFS);
            setDownloadStatus(userId, packageName, null); // Clear download
            return `System updated to version ${targetVersion} (${currentBranch} branch)`;
          } else {
            // Handle package installation
            const pkgDir = userFS.fs["/"].children.sys.children.pkgs.children;
            const currentVersion = userFS.fs["/"].children.sys.children.os_version?.content || "1.0.0";
            const currentBranch = userFS.fs["/"].children.sys.children.os_branch?.content || "stable";

            // Create package entry
            pkgDir[`${packageName}.pkg`] = {
              type: "file",
              content: `Package: ${packageName}\nVersion: ${currentVersion}\nBranch: ${currentBranch}`,
            };

            await saveToDB("user_filesystems", userId, userFS);
            setDownloadStatus(userId, packageName, null); // Clear download
            return `Package ${packageName} installed successfully`;
          }
        }
        
        // Otherwise return the current step's message
        return step.message;
      } else {
        // Initial request, just show current step
        return step.message;
      }
    } else {
      // Download is complete, remove tracking
      setDownloadStatus(userId, packageName, null);
      if (isUpdate) {
        return `System updated to version ${downloadState.targetVersion}`;
      } else {
        return `Package ${packageName} installed successfully`;
      }
    }
  } else if (initialRequest) {
    // Start new download
    let steps;
    
    if (isUpdate) {
      // For update downloads
      const targetVersion = packageName.split('-')[1];
      const updateSize = getUpdateSize(targetVersion);
      steps = await createDownloadSteps(userId, packageName, updateSize);
      
      // If we have instant download
      if (steps.length === 1 && steps[0].wait === 0) {
        const currentBranch = userFS.fs["/"].children.sys.children.os_branch?.content || "stable";
        userFS.fs["/"].children.sys.children.os_version.content = targetVersion;
        await saveToDB("user_filesystems", userId, userFS);
        return `System updated to version ${targetVersion} (${currentBranch} branch)`;
      }
      
      // Set up download state with target version
      setDownloadStatus(userId, packageName, {
        steps,
        currentStep: 0,
        lastUpdate: Date.now(),
        isUpdate: true,
        targetVersion
      });
      
      return `Started downloading system update to ${targetVersion}...\n${steps[0].message}`;
    } else {
      // For package downloads
      // Get package size from loaded packages
      loadPackages();
      const packageSize = PACKAGE_SIZES[packageName];
      steps = await createDownloadSteps(userId, packageName, packageSize);
      
      // If we have instant download
      if (steps.length === 1 && steps[0].wait === 0) {
        const pkgDir = userFS.fs["/"].children.sys.children.pkgs.children;
        const currentVersion = userFS.fs["/"].children.sys.children.os_version?.content || "1.0.0";
        const currentBranch = userFS.fs["/"].children.os_branch?.content || "stable";
        
        // Create package entry immediately
        pkgDir[`${packageName}.pkg`] = {
          type: "file",
          content: `Package: ${packageName}\nVersion: ${currentVersion}\nBranch: ${currentBranch}`,
        };
        
        await saveToDB("user_filesystems", userId, userFS);
        return `Installed package: ${packageName}`;
      }
      
      // Set up new download state
      setDownloadStatus(userId, packageName, {
        steps,
        currentStep: 0,
        lastUpdate: Date.now(),
      });
      
      return `Started downloading ${packageName}...\n${steps[0].message}`;
    }
  } else {
    // No download in progress and not an initial request
    return null;
  }
}

/**
 * Start an OS update download simulation
 * @param {string} userId - User ID 
 * @param {string} targetVersion - Version to update to
 * @returns {Promise<Object>} - Initial download state
 */
async function startUpdateDownload(userId, targetVersion) {
  const updateSize = getUpdateSize(targetVersion);
  
  // Create download steps using the network simulation
  const steps = await createDownloadSteps(userId, `update-${targetVersion}`, updateSize);
  
  // Set up download state
  const downloadState = {
    steps,
    currentStep: 0,
    lastUpdate: Date.now(),
    isUpdate: true,
    targetVersion
  };
  
  // Register the download
  setDownloadStatus(userId, `update-${targetVersion}`, downloadState);
  
  return downloadState;
}

/**
 * Package manager command
 * @param {string} userId - User ID
 * @param {Array} args - Command arguments
 * @returns {string} - Command output
 */
async function pkgCommand(userId, args) {
  // Refresh package and update definitions
  loadPackages();
  loadUpdates();
  
  const subcommand = args[0];
  if (!subcommand) {
    return 'pkg: Missing subcommand. Use "install", "remove", "list", "search", "branches", "status", or "upgrade".';
  }

  const userFS = await loadFromDB("user_filesystems", userId, createFilesystem());
  const sysDir = userFS.fs["/"].children.sys;

  // Make sure os_branch exists
  if (!sysDir.children.os_branch) {
    sysDir.children.os_branch = { type: "file", content: "stable" };
  }

  if (subcommand === "upgrade") {
    // Check for branch option
    const branchIndex = args.findIndex((arg) => arg.startsWith("--"));
    let targetBranch = "stable"; // Default to stable

    if (branchIndex !== -1) {
      const branchArg = args[branchIndex].substring(2);
      if (!osBranches[branchArg]) {
        return `pkg: Unknown branch '${branchArg}'. Available branches: ${Object.keys(osBranches).join(", ")}`;
      }
      targetBranch = branchArg;
    }

    if (!sysDir.children.os_version) {
      sysDir.children.os_version = { type: "file", content: "1.0.0" };
    }

    const currentVersion = sysDir.children.os_version.content;
    const currentBranch = sysDir.children.os_branch.content;
    const targetVersion = osBranches[targetBranch];

    if (currentVersion === targetVersion && currentBranch === targetBranch) {
      return `Your system is already up to date on branch '${targetBranch}'.`;
    }

    // Handle downgrade scenario - detect if going from unstable to stable
    const isDowngrade = currentBranch === "unstable" && targetBranch === "stable" && compareVersions(currentVersion, targetVersion) > 0;
    
    // Change branch first (even if version stays the same)
    sysDir.children.os_branch.content = targetBranch;
    await saveToDB("user_filesystems", userId, userFS);

    // Start the update download with network simulation
    const downloadState = await startUpdateDownload(userId, targetVersion);
    const firstStep = downloadState.steps[0];
    
    if (isDowngrade) {
      return `Starting downgrade from ${currentBranch} (${currentVersion}) to ${targetBranch} (${targetVersion})...\n${firstStep.message}`;
    } else {
      return `Starting system ${currentVersion === targetVersion ? "switch" : "upgrade"} to ${targetVersion} (${targetBranch} branch)...\n${firstStep.message}`;
    }
  }

  const pkgDir = sysDir.children.pkgs.children;
  const currentVersion = sysDir.children.os_version?.content || "1.0.0";
  const currentBranch = sysDir.children.os_branch?.content || "stable";

  switch (subcommand) {
    case "install": {
      const pkgName = args[1];
      if (!pkgName) return "Usage: pkg install <package>";

      // Check if the package is already installed
      if (pkgDir[`${pkgName}.pkg`]) {
        return `pkg: Package '${pkgName}' is already installed.`;
      }

      // Check if package is available for the current version and branch
      if (!isPackageAvailable(pkgName, currentVersion, currentBranch)) {
        // If package exists but isn't available in this branch/version
        if (packageDefinitions[pkgName]) {
          if (packageDefinitions[pkgName][currentBranch]) {
            return `pkg: Package '${pkgName}' requires ${currentBranch} version ${packageDefinitions[pkgName][currentBranch].minVersion} or later.`;
          } else {
            return `pkg: Package '${pkgName}' is not available on the ${currentBranch} branch.`;
          }
        }
        return `pkg: Package '${pkgName}' not found.`;
      }

      // Cancel any existing download for this package
      setDownloadStatus(userId, pkgName, null);

      // Check if there's an existing download or start a new one
      return await processDownload(userId, userFS, pkgName, true);
    }

    case "remove": {
      const pkgName = args[1];
      if (!pkgName) return "Usage: pkg remove <package>";

      // Cancel any ongoing download
      setDownloadStatus(userId, pkgName, null);

      if (!pkgDir[`${pkgName}.pkg`]) return `pkg: Package not found: ${pkgName}`;

      delete pkgDir[`${pkgName}.pkg`];
      await saveToDB("user_filesystems", userId, userFS);
      return `Removed package: ${pkgName}`;
    }

    case "list": {
      const pageArgIndex = args.indexOf("--page");
      const pageNumber = pageArgIndex !== -1 ? parseInt(args[pageArgIndex + 1], 10) || 1 : 1;
      const pageSize = 5;
      const installedPackages = Object.keys(pkgDir)
        .map((pkg) => pkg.replace(".pkg", ""))
        .filter(Boolean);
      const totalPages = Math.max(1, Math.ceil(installedPackages.length / pageSize));

      if (pageNumber < 1 || pageNumber > totalPages) {
        return `pkg: Invalid page number. Valid range: 1-${totalPages}`;
      }

      const start = (pageNumber - 1) * pageSize;
      const end = start + pageSize;
      const pagePackages = installedPackages.slice(start, end);

      if (pagePackages.length === 0) {
        return "pkg: No installed packages";
      }

      // Add package sizes to the listing
      const packagesWithSizes = pagePackages.map((pkg) => {
        const size = PACKAGE_SIZES[pkg] || 0;
        return `${pkg} (${formatSize(size)})`;
      });

      return `Installed Packages (Page ${pageNumber}/${totalPages}):\n${packagesWithSizes.join("\n")}`;
    }

    case "search": {
      const query = args[1]?.toLowerCase();
      const pageSize = 6;

      // Filter available packages based on current OS version and branch
      const allPackages = Object.keys(packageDefinitions).filter((pkg) => 
        isPackageAvailable(pkg, currentVersion, currentBranch)
      );

      const filteredPackages = query 
        ? allPackages.filter((pkg) => pkg.toLowerCase().includes(query)) 
        : allPackages;

      const pageArgIndex = args.indexOf("--page");
      const pageNumber = pageArgIndex !== -1 ? parseInt(args[pageArgIndex + 1], 10) || 1 : 1;
      const totalPages = Math.max(1, Math.ceil(filteredPackages.length / pageSize));

      if (pageNumber < 1 || pageNumber > totalPages) {
        return `pkg: Invalid page number. Valid range: 1-${totalPages || 1}`;
      }

      const start = (pageNumber - 1) * pageSize;
      const end = start + pageSize;
      const pagePackages = filteredPackages.slice(start, end);

      if (pagePackages.length === 0) {
        return `pkg: No matching packages found for "${query || "all"}"`;
      }

      // Add package sizes to the listing
      const packagesWithSizes = pagePackages.map((pkg) => {
        const size = PACKAGE_SIZES[pkg] || 0;
        return `${pkg} (${formatSize(size)})`;
      });

      return `Search Results for "${
        query || "all"
      }" (${currentBranch} branch, v${currentVersion}) (Page ${pageNumber}/${totalPages}):\n${packagesWithSizes.join("\n")}`;
    }

    case "branches": {
      // Show available branches and their versions
      const branches = Object.entries(osBranches)
        .map(([branch, version]) => `${branch}: ${version}${branch === currentBranch ? " (current)" : ""}`)
        .join("\n");

      return `Available branches:\n${branches}`;
    }

    case "status": {
      // Check if a specific package download is in progress
      const pkgName = args[1];

      if (pkgName) {
        const downloadState = getDownloadStatus(userId, pkgName);
        if (downloadState) {
          const step = downloadState.steps[downloadState.currentStep];
          return step.message;
        } else {
          return `No download in progress for ${pkgName}`;
        }
      } else {
        // Check all downloads for this user
        const activeUserDownloads = Array.from(activeDownloads.keys())
          .filter((key) => key.startsWith(`${userId}:`))
          .map((key) => key.split(":")[1]);

        if (activeUserDownloads.length === 0) {
          return "No package downloads in progress";
        } else {
          return `Active downloads: ${activeUserDownloads.join(", ")}`;
        }
      }
    }

    default:
      return 'pkg: Invalid subcommand. Use "install", "remove", "list", "search", "branches", "status", or "upgrade".';
  }
}

// Initialize by loading packages and updates
loadPackages();
loadUpdates();

module.exports = {
  pkgCommand,
  isPackageAvailable,
  packageDefinitions,
  latestOSVersion,
  osBranches,
  processDownload,
  getDownloadStatus,
  setDownloadStatus,
  getUpdateSize,
  startUpdateDownload,
  PACKAGE_SIZES
};