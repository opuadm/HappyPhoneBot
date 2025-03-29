module.exports = {
    name: "echo",
    description: "Outputs the text that is input to it",
    size: 472, // Size in KB
    minVersion: {
      stable: "1.0.0",
      unstable: "1.0.0"
    },
    execute: async (interaction, userId, args) => {
      const fs = require('node:fs');
      const path = require('node:path');
      const { loadFromDB, saveToDB } = require("../../../../db/utils");
      const { createFilesystem } = require("../filesystem");
      const { resolvePath, getObjectAtPath } = require("../filesystem");
      const MAX_CONTENT_LENGTH = require("../filesystem").MAX_CONTENT_LENGTH;
      
      const userFS = await loadFromDB("user_filesystems", userId, createFilesystem());
      const splitIndex = args.indexOf(">>");
      let content = "";
  
      if (splitIndex === -1) {
        content = args.join(" ");
      } else {
        content = args.slice(0, splitIndex).join(" ");
      }
  
      if (content.length > MAX_CONTENT_LENGTH) {
        return `Error: Content exceeds the limit of ${MAX_CONTENT_LENGTH} characters.`;
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
    }
  };