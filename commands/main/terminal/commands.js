const path = require("node:path");
const { loadFromDB, saveToDB } = require("../../../db/utils");
const { resolvePath, getObjectAtPath, createFilesystem, MAX_CONTENT_LENGTH } = require("./filesystem");
const { getUserNetworkConfig, saveUserNetworkConfig } = require("./network");

// Import pkgModule directly for the packageDefinitions only
// We'll register the package commands separately to avoid circular dependencies
const pkgModule = require("./pkg");
const { getDownloadStatus, processDownload } = pkgModule;
const { packageDefinitions } = pkgModule;

// System commands that are always available
const systemCommands = {
  cd: {
    execute: async (userId, args) => {
      const userFS = await loadFromDB("user_filesystems", userId, createFilesystem());
      let target = args[0] || "/";
      if (target === "...") target = "/";

      const newPath = resolvePath(userFS.currentDir, target);
      let current = userFS.fs["/"];

      for (const part of newPath.split("/").filter((p) => p)) {
        if (!current.children?.[part] || current.children[part].type !== "directory") {
          return `cd: ${newPath}: No such directory`;
        }
        current = current.children[part];
      }

      userFS.currentDir = newPath;
      await saveToDB("user_filesystems", userId, userFS);

      // Check for ongoing downloads and update them
      const userFS2 = await loadFromDB("user_filesystems", userId, createFilesystem());
      const pkgNames = Object.keys(packageDefinitions);
      for (const pkgName of pkgNames) {
        if (getDownloadStatus(userId, pkgName)) {
          await processDownload(userId, userFS2, pkgName, false);
        }
      }

      return newPath;
    },
  },

  ls: {
    execute: async (userId, args) => {
      const userFS = await loadFromDB("user_filesystems", userId, createFilesystem());
      const targetPath = resolvePath(userFS.currentDir, args[0] || userFS.currentDir);

      let current = userFS.fs["/"];
      for (const part of targetPath.split("/").filter((p) => p)) {
        if (!current.children?.[part]) return `ls: ${targetPath}: No such directory`;
        current = current.children[part];
      }

      // Check for ongoing downloads and update them
      const userFS2 = await loadFromDB("user_filesystems", userId, createFilesystem());
      const pkgNames = Object.keys(packageDefinitions);
      for (const pkgName of pkgNames) {
        if (getDownloadStatus(userId, pkgName)) {
          await processDownload(userId, userFS2, pkgName, false);
        }
      }

      return (
        Object.keys(current.children)
          .map((name) => `${current.children[name].type === "directory" ? "📁 " : "📄 "}${name}`)
          .join("\n") || "Empty directory"
      );
    },
  },

  touch: {
    execute: async (userId, args) => {
      if (!args.length) return "touch: Missing filename";

      const userFS = await loadFromDB("user_filesystems", userId, createFilesystem());
      const fullPath = resolvePath(userFS.currentDir, args.join(" "));

      const { parent, fileName, found, error } = getObjectAtPath(userFS, fullPath, true);
      if (error) return `touch: ${error}`;

      // Create/update the file
      parent.children[fileName] = { type: "file", content: "" };

      await saveToDB("user_filesystems", userId, userFS);
      return `Created file: ${fullPath}`;
    },
  },

  test: {
    execute: async (userId, args) => `Test command executed with args: ${args.join(" ")}`,
  },

  mkdir: {
    execute: async (userId, args) => {
      if (!args.length) return "mkdir: Missing directory name";

      const userFS = await loadFromDB("user_filesystems", userId, createFilesystem());
      const fullPath = resolvePath(userFS.currentDir, args.join(" "));

      const { parent, fileName, error } = getObjectAtPath(userFS, fullPath, true);
      if (error) return `mkdir: ${error}`;

      if (parent.children[fileName] && parent.children[fileName].type !== "directory") {
        return `mkdir: Cannot create directory '${fileName}': File exists`;
      }

      parent.children[fileName] = { type: "directory", children: {} };
      await saveToDB("user_filesystems", userId, userFS);
      return `Created directory: ${fullPath}`;
    },
  },

  rm: {
    execute: async (userId, args) => {
      if (!args.length) return "rm: Missing filename";

      const userFS = await loadFromDB("user_filesystems", userId, createFilesystem());
      const fullPath = resolvePath(userFS.currentDir, args.join(" "));

      const { parent, fileName, found, error } = getObjectAtPath(userFS, fullPath);
      if (error) return `rm: ${error}`;
      if (!found) return `rm: ${fullPath}: No such file or directory`;

      delete parent.children[fileName];
      await saveToDB("user_filesystems", userId, userFS);
      return `Removed: ${fullPath}`;
    },
  },

  netset: {
    execute: async (userId, args) => {
      if (args.length < 2) {
        return "Usage: netset <unit> <value> or netset <value> <unit>\nAvailable units: bps, kbps, mbps, gbps, tbps";
      }

      let unit = args[0].toLowerCase();
      let value = parseFloat(args[1]);
      // If second arg isn't a number but first is, swap
      if (isNaN(value) && !isNaN(parseFloat(args[0]))) {
        value = parseFloat(args[0]);
        unit = args[1].toLowerCase();
      }

      if (isNaN(value) || value <= 0) {
        return "Invalid speed value. Please provide a positive number.";
      }

      const { getUserNetworkConfig, saveUserNetworkConfig, recalculateDownloadSteps } = require("./network");
      const config = await getUserNetworkConfig(userId);

      // Normalize unit into Mbps
      let speedInMbps;
      switch (unit) {
        case "bps":   speedInMbps = value / 1e6; break;
        case "kbps":  speedInMbps = value / 1e3; break;
        case "mbps":  speedInMbps = value;      break;
        case "gbps":  speedInMbps = value * 1e3;break;
        case "tbps":  speedInMbps = value * 1e6;break;
        default:
          return `Unknown unit: ${unit}. Available units: bps, kbps, mbps, gbps, tbps`;
      }

      config.speed = speedInMbps;
      await saveUserNetworkConfig(userId, config);

      // Recalculate active downloads
      try {
        const { packageDefinitions, getDownloadStatus, setDownloadStatus } = require("./pkg");
        for (const pkgName of Object.keys(packageDefinitions)) {
          const ds = getDownloadStatus(userId, pkgName);
          if (ds && ds.currentStep < ds.steps.length) {
            const updated = await recalculateDownloadSteps(userId, pkgName, ds);
            setDownloadStatus(userId, pkgName, updated);
          }
        }
      } catch (e) {
        console.error("Error recalculating downloads:", e);
      }

      return `Network speed set to ${value} ${unit.toUpperCase()} (${speedInMbps} Mbps)`;
    },
  },

  netinfo: {
    execute: async (userId, args) => {
      const config = await getUserNetworkConfig(userId);

      return `Network Configuration:
Speed: ${config.speed} Mbps
Latency: ${config.latency} ms
Packet Loss: ${config.packetLoss}%
Jitter: ${config.jitter} ms
Network Simulation: ${config.enabled ? "Enabled" : "Disabled"}`;
    },
  },

  nettoggle: {
    execute: async (userId, args) => {
      const config = await getUserNetworkConfig(userId);
      config.enabled = !config.enabled;
      await saveUserNetworkConfig(userId, config);
      return `Network simulation ${config.enabled ? "enabled" : "disabled"}`;
    },
  },

  netlatency: {
    execute: async (userId, args) => {
      if (args.length < 1) return "Usage: netlatency <value in ms>";
      const value = parseFloat(args[0]);
      if (isNaN(value) || value < 0) return "Invalid latency value. Please provide a non-negative number.";

      // Update config
      const { getUserNetworkConfig, saveUserNetworkConfig, recalculateDownloadSteps } = require("./network");
      const config = await getUserNetworkConfig(userId);
      config.latency = value;
      await saveUserNetworkConfig(userId, config);

      // Recalculate active downloads
      const { packageDefinitions, getDownloadStatus, setDownloadStatus } = require("./pkg");
      for (const pkgName of Object.keys(packageDefinitions)) {
        const ds = getDownloadStatus(userId, pkgName);
        if (ds && ds.currentStep < ds.steps.length) {
          const updated = await recalculateDownloadSteps(userId, pkgName, ds);
          setDownloadStatus(userId, pkgName, updated);
        }
      }

      return `Network latency set to ${value} ms`;
    },
  },

  netjitter: {
    execute: async (userId, args) => {
      if (args.length < 1) return "Usage: netjitter <value in ms>";
      const value = parseFloat(args[0]);
      if (isNaN(value) || value < 0) return "Invalid jitter value. Please provide a non-negative number.";

      // Update config
      const { getUserNetworkConfig, saveUserNetworkConfig, recalculateDownloadSteps } = require("./network");
      const config = await getUserNetworkConfig(userId);
      config.jitter = value;
      await saveUserNetworkConfig(userId, config);

      // Recalculate active downloads
      const { packageDefinitions, getDownloadStatus, setDownloadStatus } = require("./pkg");
      for (const pkgName of Object.keys(packageDefinitions)) {
        const ds = getDownloadStatus(userId, pkgName);
        if (ds && ds.currentStep < ds.steps.length) {
          const updated = await recalculateDownloadSteps(userId, pkgName, ds);
          setDownloadStatus(userId, pkgName, updated);
        }
      }

      return `Network jitter set to ${value} ms`;
    },
  },

  netloss: {
    execute: async (userId, args) => {
      if (args.length < 1) return "Usage: netloss <percentage>";
      const value = parseFloat(args[0]);
      if (isNaN(value) || value < 0 || value > 100) return "Invalid packet loss value. Please provide a number between 0 and 100.";

      // Update config
      const { getUserNetworkConfig, saveUserNetworkConfig, recalculateDownloadSteps } = require("./network");
      const config = await getUserNetworkConfig(userId);
      config.packetLoss = value;
      await saveUserNetworkConfig(userId, config);

      // Recalculate active downloads
      const { packageDefinitions, getDownloadStatus, setDownloadStatus } = require("./pkg");
      for (const pkgName of Object.keys(packageDefinitions)) {
        const ds = getDownloadStatus(userId, pkgName);
        if (ds && ds.currentStep < ds.steps.length) {
          const updated = await recalculateDownloadSteps(userId, pkgName, ds);
          setDownloadStatus(userId, pkgName, updated);
        }
      }

      return `Network packet loss set to ${value}%`;
    },
  },

  cat: {
    execute: async (userId, args) => {
      if (!args.length) return "cat: Missing filename";

      const userFS = await loadFromDB("user_filesystems", userId, createFilesystem());
      const fullPath = resolvePath(userFS.currentDir, args.join(" "));

      const { target, found, error } = getObjectAtPath(userFS, fullPath);
      if (error) return `cat: ${error}`;
      if (!found) return `cat: ${fullPath}: No such file`;

      if (target.type === "directory") return `cat: ${fullPath}: Is a directory`;
      if (target.readOnly && target.hidden) return `cat: ${fullPath}: Permission denied`;

      return target.content || "(empty file)";
    },
  },
};

// Commands that need to be installed via pkg manager
// Define the structure first, will be populated later by registerPackageCommands
const installableCommands = {
  echo: {
    execute: async (interaction, userId, args) => {
      const userFS = await loadFromDB("user_filesystems", userId, createFilesystem());
      const splitIndex = args.indexOf(">>");
      let content = "";

      if (splitIndex === -1) {
        content = args.join(" ");
      } else {
        content = args.slice(0, splitIndex).join(" ");
      }

      if (content.length > MAX_CONTENT_LENGTH) {
        return `Error: File content exceeds the limit of ${MAX_CONTENT_LENGTH} characters.`;
      }

      if (splitIndex !== -1) {
        const filePath = resolvePath(userFS.currentDir, args.slice(splitIndex + 1).join(" "));
        const { parent, fileName, error } = getObjectAtPath(userFS, filePath, true);

        if (error) return `echo: ${error}`;

        parent.children[fileName] = { type: "file", content };
        await saveToDB("user_filesystems", userId, userFS);
        return `Written to ${filePath}`;
      }

      return content;
    },
  },

  edit: {
    execute: async () => 'edit: Use the "edit-file" action (with the arg0 field specifying the filename) to use the edit command!',
  },

  happyphone: {
    execute: async () => "Make it happy RN",
  },
};

module.exports = {
  systemCommands,
  installableCommands,
};

// Register package commands after everything is exported
// This helps avoid circular dependency issues
pkgModule.registerPackageCommands();
