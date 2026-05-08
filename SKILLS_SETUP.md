# Skills Plugin Setup

The Skills plugin system has been successfully installed!

## Important: Restart Required

After installing the skills plugin system for the first time, you **must restart the DagFlux application** for the skills API to be available in the renderer process.

## Verifying Installation

After restarting, you can verify skills are working:

### 1. Check Console
Open Developer Tools (Cmd+Option+I on Mac, Ctrl+Shift+I on Windows) and run:

```javascript
// Check if skills API is available
console.log('Skills API:', window.electronAPI.skills);

// List installed skills
window.electronAPI.skills.listInstalled().then(result => {
  console.log('Installed skills:', result);
});
```

Expected output:
```javascript
{
  success: true,
  skills: [
    {
      id: 'python-executor',
      name: 'Python Executor',
      type: 'skill',
      category: 'transformer',
      version: '1.0.0',
      description: 'Execute Python code for complex data transformations',
      metadata: { ... }
    }
  ]
}
```

### 2. Check ConnectionTypeSelector

1. Click "New Connection" or open ConnectionTypeSelector
2. Click on the "Skills" tab
3. You should see "Python Executor" listed

If you see "No skills installed yet" instead, the app needs to be restarted.

## Files Modified

The following files were updated to support skills:

1. **`/public/pluginManager.js`**
   - Added skills loading and management
   - New methods: `loadSkills()`, `getSkill()`, `listSkills()`, `executeSkill()`

2. **`/public/electron.js`**
   - Added IPC handlers for skills:
     - `skills:listInstalled`
     - `skills:getByCategory`
     - `skills:getDescriptions`
     - `skills:execute`

3. **`/public/preload.js`**
   - Exposed skills API to renderer process via `window.electronAPI.skills`

4. **`/src/components/Workflows/ConnectionTypeSelector.js`**
   - Added "Skills" tab
   - Displays installed skills

5. **`/src/components/Workflows/NodeChats/ChatPrompts/Transformer.js`**
   - Updated to include skill descriptions in AI prompts

6. **`/src/components/Workflows/NodeChats/ChatPrompts/Join.js`**
   - Updated to include skill descriptions in AI prompts

## Installed Skills

### Python Executor (`python-executor`)
- **Category**: Transformer
- **Description**: Execute Python code for complex data transformations
- **Location**: `/plugins/skills/python-executor/`
- **Setup**: Run `./setup.sh` (Unix/macOS) or `setup.bat` (Windows)
- **Documentation**: See `/plugins/skills/python-executor/README.md`

## Troubleshooting

### Skills Tab Shows "No skills installed yet"

**Solution**: Restart the DagFlux application completely.

The preload script only loads once when the app starts. If you added the skills API after the app was already running, you need to restart.

### Skills API Not Available

Check in Developer Console:
```javascript
console.log(window.electronAPI.skills);
```

If it shows `undefined`, restart the app.

### Python Skill Not Loading

Check the main process console for errors:
1. The skill file must be at `/plugins/skills/python-executor/index.js`
2. The skill must export `type: 'skill'`
3. The skill must have `getDescription()` and `execute()` methods

View logs:
```
Loading skill plugins from: /path/to/plugins/skills
✓ Loaded skill plugin: Python Executor
Loaded 1 skill plugins
```

## Next Steps

1. **Restart the DagFlux app** if you haven't already
2. Install Python dependencies for the Python Executor skill:
   ```bash
   cd plugins/skills/python-executor
   ./setup.sh  # or setup.bat on Windows
   ```
3. Test the Python skill:
   - Create a Transformer node
   - Ask for a complex transformation like "calculate moving average with pandas"
   - The AI should use the Python Executor skill

## Creating Your Own Skills

See `/plugins/skills/README.md` for documentation on creating custom skill plugins.

Example skill structure:
```javascript
module.exports = {
  type: 'skill',
  id: 'my-skill',
  name: 'My Skill',
  category: 'transformer',

  getDescription: () => ({ ... }),
  getTransformPrompts: () => ({ ... }),
  execute: async (params) => { ... },

  metadata: { ... }
};
```
