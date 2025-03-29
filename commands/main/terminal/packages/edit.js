module.exports = {
    name: "edit",
    description: "Edit files using the terminal interface",
    size: 8400, // Size in KB
    minVersion: {
      stable: "1.0.0",
      unstable: "1.0.0"
    },
    execute: async () => 'edit: Use the "edit-file" action (with the arg0 field specifying the filename) to use the edit command!'
  };