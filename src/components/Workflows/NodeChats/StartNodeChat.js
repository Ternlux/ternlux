import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { message, Select, InputNumber, TimePicker, Button } from 'antd';
import dayjs from 'dayjs';
import ChatArea from '../../Chat/ChatArea';

const { Option } = Select;

/**
 * Start Node Chat Component
 * Handles three trigger types: Manual, Time-based (CRON), File/Folder watching
 */
const StartNodeChat = ({ node, onSave, onConfigUpdate, currentWorkflowId, initialChat }) => {
  const messagesEndRef = useRef(null);
  const chatContainerRef = useRef(null);
  const inputRef = useRef(null);

  // Chat state
  const [chat, setChat] = useState(initialChat || []);
  const [inputValue, setInputValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [saveState, setSaveState] = useState(false);
  const [disableInput, setDisableInput] = useState(true);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Trigger configuration
  const [triggerType, setTriggerType] = useState(null); // 'manual', 'time', 'file'
  const [currentStep, setCurrentStep] = useState('triggerType'); // Track current configuration step
  const [cronConfig, setCronConfig] = useState({
    frequency: null, // 'yearly', 'monthly', 'weekly', 'daily', 'hourly'
    month: null,
    day: null,
    dayOfWeek: null,
    hour: 0,
    minute: 0
  });
  const [fileWatchConfig, setFileWatchConfig] = useState({
    path: null,
    type: 'file', // 'file' or 'directory'
    events: [], // ['add', 'change', 'unlink', 'addDir', 'unlinkDir']
    pattern: null // Optional glob pattern
  });
  const [pendingEventSelection, setPendingEventSelection] = useState(false); // Track if user is selecting events

  // ─────────────────────────────────────────────────────────────────────────
  // Initialize
  // ─────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const config = node?.data?.config;

    console.log('[StartNodeChat] Initializing with config:', config);
    console.log('[StartNodeChat] Initial chat length:', initialChat?.length || 0);

    // Check if this is truly a configured node (has nodeType: 'start' from a save)
    // AND initialChat has content (not a reset)
    const isConfigured = config?.nodeType === 'start' && config?.triggerType && initialChat && initialChat.length > 0;

    // Check if this is a saved/configured node with chat history
    if (isConfigured) {
      console.log('[StartNodeChat] Loading saved configuration:', config.triggerType);

      // Restore saved configuration state
      setTriggerType(config.triggerType);

      if (config.triggerType === 'time' && config.cronConfig) {
        setCronConfig(config.cronConfig);
      }

      if (config.triggerType === 'file' && config.fileWatchConfig) {
        setFileWatchConfig(config.fileWatchConfig);
      }

      // Chat already restored via initialChat prop
      setSaveState(true);
      setCurrentStep('complete');
      setHasUnsavedChanges(false); // Already saved, no unsaved changes
      setPendingEventSelection(false);
    } else {
      // Fresh start OR reset - show welcome message
      console.log('[StartNodeChat] Fresh start or reset, showing welcome');
      addBotMessage('Welcome! Let\'s configure how this workflow should start.', false);
      setCurrentStep('triggerType');
      setHasUnsavedChanges(false); // New node, nothing to save yet
      setPendingEventSelection(false);
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Chat helpers
  // ─────────────────────────────────────────────────────────────────────────

  const addBotMessage = (text, requiresInput = false, metadata = {}) => {
    setChat(prev => [
      ...prev,
      {
        id: Date.now(),
        sender: 'bot',
        text,
        timestamp: new Date(),
        metadata
      }
    ]);
  };

  const addUserMessage = (text) => {
    setChat(prev => [
      ...prev,
      {
        id: Date.now(),
        sender: 'user',
        text,
        timestamp: new Date()
      }
    ]);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // CRON helpers
  // ─────────────────────────────────────────────────────────────────────────

  const buildCronExpression = () => {
    const { frequency, month, day, dayOfWeek, hour, minute } = cronConfig;

    if (frequency === 'yearly') {
      return `${minute} ${hour} ${day} ${month} *`;
    } else if (frequency === 'monthly') {
      return `${minute} ${hour} ${day} * *`;
    } else if (frequency === 'weekly') {
      return `${minute} ${hour} * * ${dayOfWeek}`;
    } else if (frequency === 'daily') {
      return `${minute} ${hour} * * *`;
    } else if (frequency === 'hourly') {
      return `${minute} * * * *`;
    }

    return null;
  };

  const getScheduleDescription = () => {
    const { frequency, month, day, dayOfWeek, hour, minute } = cronConfig;
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    if (frequency === 'yearly') {
      return `Every year on ${monthNames[month - 1]} ${day} at ${hour}:${minute.toString().padStart(2, '0')}`;
    } else if (frequency === 'monthly') {
      return `Every month on day ${day} at ${hour}:${minute.toString().padStart(2, '0')}`;
    } else if (frequency === 'weekly') {
      return `Every ${dayNames[dayOfWeek]} at ${hour}:${minute.toString().padStart(2, '0')}`;
    } else if (frequency === 'daily') {
      return `Every day at ${hour}:${minute.toString().padStart(2, '0')}`;
    } else if (frequency === 'hourly') {
      return `Every hour at minute ${minute}`;
    }

    return 'Not configured';
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Display choices based on current step
  // ─────────────────────────────────────────────────────────────────────────
  const displayChoicesSecondary = () => {
    // Only show save button when in fileEvents step AND events are selected AND not yet saved
    if (currentStep === 'fileEvents' && fileWatchConfig.events.length > 0 && !saveState) {
      return [{ label: 'Save Configuration', value: 'save', variant: 'contained', fullWidth: true }];
    }
    return [];
  }
  // console.log('setFileWatchConfig: ', fileWatchConfig)
  const displayChoices = () => {
    if (loading) return [];

    // Show save button only when configuration is ready AND has unsaved changes
    if (saveState && hasUnsavedChanges) {
      return [{
        label: 'Save Configuration',
        value: 'save',
        variant: 'contained',
        fullWidth: true
      }];
    }

    // Hide choices while selecting file path
    if (currentStep === 'selectingPath') {
      return [];
    }

    // Trigger type selection
    if (currentStep === 'triggerType') {
      return [
        {
          label: 'Manual',
          value: 'manual',
          description: 'Start workflow manually when needed',
          variant: 'outlined',
          fullWidth: false
        },
        {
          label: 'Time-based (Schedule)',
          value: 'time',
          description: 'Run workflow on a schedule using CRON',
          variant: 'outlined',
          fullWidth: false
        },
        {
          label: 'File/Folder Watch',
          value: 'file',
          description: 'Trigger when files or folders change',
          variant: 'outlined',
          fullWidth: false
        }
      ];
    }

    // Frequency selection for time-based triggers
    if (currentStep === 'frequency') {
      return [
        { label: 'Yearly', value: 'yearly', description: 'Run once per year', variant: 'outlined', fullWidth: false },
        { label: 'Monthly', value: 'monthly', description: 'Run once per month', variant: 'outlined', fullWidth: false },
        { label: 'Weekly', value: 'weekly', description: 'Run once per week', variant: 'outlined', fullWidth: false },
        { label: 'Daily', value: 'daily', description: 'Run once per day', variant: 'outlined', fullWidth: false },
        { label: 'Hourly', value: 'hourly', description: 'Run once per hour', variant: 'outlined', fullWidth: false }
      ];
    }

    // Month selection for yearly frequency
    if (currentStep === 'month') {
      return [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
      ].map((month, idx) => ({
        label: month,
        value: idx + 1,
        displayType: 'dropdown',
        variant: 'outlined'
      }));
    }

    // Day of week selection for weekly frequency
    if (currentStep === 'dayOfWeek') {
      return [
        'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
      ].map((day, idx) => ({
        label: day,
        value: idx,
        displayType: 'dropdown',
        variant: 'outlined'
      }));
    }

    // File type selection
    if (currentStep === 'fileType') {
      return [
        {
          label: 'Single File',
          value: 'file',
          description: 'Watch a specific file',
          variant: 'outlined',
          fullWidth: false
        },
        {
          label: 'Directory',
          value: 'directory',
          description: 'Watch all files in a folder',
          variant: 'outlined',
          fullWidth: false
        }
      ];
    }

    // File event selection - show dropdown only
    if (currentStep === 'fileEvents') {
      const isWatchingFile = fileWatchConfig.type === 'file';

      // Filter events based on whether watching a file or directory
      const availableEvents = isWatchingFile
        ? [
            { label: 'File Added', value: 'add', description: 'When the file is created' },
            { label: 'File Changed', value: 'change', description: 'When the file is modified' },
            { label: 'File Deleted', value: 'unlink', description: 'When the file is removed' }
          ]
        : [
            { label: 'File Added', value: 'add', description: 'When a file is created in the directory' },
            { label: 'File Changed', value: 'change', description: 'When a file is modified in the directory' },
            { label: 'File Deleted', value: 'unlink', description: 'When a file is removed from the directory' },
            { label: 'Directory Added', value: 'addDir', description: 'When a subdirectory is created' },
            { label: 'Directory Deleted', value: 'unlinkDir', description: 'When a subdirectory is removed' }
          ];

      return availableEvents.map(event => ({
        ...event,
        displayType: 'dropdown',
        multiSelect: true,
        selectedValues: fileWatchConfig.events // Pass current selection to maintain it
      }));
    }

    return [];
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Handle choice selections
  // ─────────────────────────────────────────────────────────────────────────

  const handleChoiceClick = async (choice) => {
    if (choice.value === 'save') {
      await handleSave();
      return;
    }

    if (choice.value === 'confirm_events') {
      // User confirmed their event selection
      const eventMap = {
        add: 'File Added',
        change: 'File Changed',
        unlink: 'File Deleted',
        addDir: 'Directory Added',
        unlinkDir: 'Directory Deleted'
      };

      const eventNames = fileWatchConfig.events.map(e => eventMap[e]);
      addUserMessage(`Confirmed: ${eventNames.join(', ')}`);
      addBotMessage(`${fileWatchConfig.events.length} event(s) selected. Click Save to complete configuration.`, false);

      setPendingEventSelection(false);
      setSaveState(true);
      return;
    }

    // Mark as having unsaved changes
    setHasUnsavedChanges(true);

    // Handle multiselect dropdown (file events) - just update state, don't proceed yet
    if (choice.multiSelect && currentStep === 'fileEvents') {
      const selectedEventValues = choice.value; // Array of selected values
      setFileWatchConfig(prev => ({ ...prev, events: selectedEventValues }));
      setPendingEventSelection(selectedEventValues.length > 0);
      return;
    }

    // Add user message for all other steps
    addUserMessage(choice.label);

    // Handle based on current step
    if (currentStep === 'triggerType') {
      setTriggerType(choice.value);

      if (choice.value === 'manual') {
        addBotMessage('Manual trigger configured! Click Save below to complete setup.', false);
        setSaveState(true);
        setCurrentStep('complete');
      } else if (choice.value === 'time') {
        addBotMessage('Time-based trigger selected. Let\'s set up the schedule.', false);
        addBotMessage('How often should this workflow run?', false);
        setCurrentStep('frequency');
      } else if (choice.value === 'file') {
        addBotMessage('File/folder watch selected. Let\'s configure what to monitor.', false);
        addBotMessage('Would you like to watch a file or a directory?', false);
        setCurrentStep('fileType');
      }
    } else if (currentStep === 'frequency') {
      setCronConfig(prev => ({ ...prev, frequency: choice.value }));

      if (choice.value === 'yearly') {
        addBotMessage('Which month?', false);
        setCurrentStep('month');
      } else if (choice.value === 'monthly') {
        addBotMessage('Which day of the month? (Enter 1-31 below)', false);
        setCurrentStep('dayInput');
        setDisableInput(false);
      } else if (choice.value === 'weekly') {
        addBotMessage('Which day of the week?', false);
        setCurrentStep('dayOfWeek');
      } else if (choice.value === 'daily') {
        addBotMessage('What time? (Enter as HH:MM, e.g., 09:30)', false);
        setCurrentStep('timeInput');
        setDisableInput(false);
      } else if (choice.value === 'hourly') {
        addBotMessage('At which minute? (Enter 1-60 below)', false);
        setCurrentStep('minuteInput');
        setDisableInput(false);
      }
    } else if (currentStep === 'month') {
      setCronConfig(prev => ({ ...prev, month: choice.value }));
      addBotMessage(`${choice.label} selected. Which day of the month? (Enter 1-31 below)`, false);
      setCurrentStep('dayInput');
      setDisableInput(false);
    } else if (currentStep === 'dayOfWeek') {
      setCronConfig(prev => ({ ...prev, dayOfWeek: choice.value }));
      addBotMessage(`${choice.label} selected. What time? (Enter as HH:MM, e.g., 09:30)`, false);
      setCurrentStep('timeInput');
      setDisableInput(false);
    } else if (currentStep === 'fileType') {
      setFileWatchConfig(prev => ({ ...prev, type: choice.value }));

      // Move to a temporary step to hide the file type choices
      setCurrentStep('selectingPath');

      // Open file/directory picker
      const dialogOptions = choice.value === 'file'
        ? { properties: ['openFile'] }
        : { properties: ['openDirectory'] };

      try {
        const result = await window.electronAPI.openFileDialog(dialogOptions);

        if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
          const selectedPath = result.filePaths[0];
          setFileWatchConfig(prev => ({ ...prev, path: selectedPath }));
          addBotMessage(`Selected: ${selectedPath}`, false);
          addBotMessage('Which events should trigger the workflow? Select all that apply by clicking multiple options:', false);
          setCurrentStep('fileEvents');
        } else {
          addBotMessage('No path selected. Please select a file or directory.', false);
          // Go back to file type selection
          setCurrentStep('fileType');
        }
      } catch (error) {
        console.error('Failed to select path:', error);
        message.error('Failed to select path');
        addBotMessage('Error selecting path. Please try again.', false);
        setCurrentStep('fileType');
      }
    } else if (currentStep === 'fileEvents') {
      // Handle file event selection (allow multiple, toggle on/off)
      const currentEvents = fileWatchConfig.events || [];
      let newEvents;

      if (currentEvents.includes(choice.value)) {
        // Remove if already selected
        newEvents = currentEvents.filter(e => e !== choice.value);
      } else {
        // Add if not selected
        newEvents = [...currentEvents, choice.value];
      }

      setFileWatchConfig(prev => ({ ...prev, events: newEvents }));

      // Update message with current selections
      if (newEvents.length > 0) {
        const eventNames = newEvents.map(e => {
          const eventMap = { add: 'File Added', change: 'File Changed', unlink: 'File Deleted', addDir: 'Directory Added', unlinkDir: 'Directory Deleted' };
          return eventMap[e];
        });

        // Don't move to complete yet - let user keep selecting
        // Just update the message to show current selections
        if (newEvents.length === 1) {
          addBotMessage(`Selected: ${eventNames[0]}. You can select more events or click Save when done.`, false);
        } else {
          addBotMessage(`Selected ${newEvents.length} events: ${eventNames.join(', ')}. Click Save when done.`, false);
        }
        setSaveState(true);
        // Keep in fileEvents step to allow more selections
      } else {
        addBotMessage('No events selected. Please select at least one event.', false);
        setSaveState(false);
      }
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Handle text input for day/time/minute
  // ─────────────────────────────────────────────────────────────────────────

  const handleSendMessage = async () => {
    if (!inputValue.trim()) return;

    const userInput = inputValue.trim();
    addUserMessage(userInput);
    setInputValue('');
    setDisableInput(true);

    // Mark as having unsaved changes
    setHasUnsavedChanges(true);

    if (currentStep === 'dayInput') {
      const day = parseInt(userInput);
      if (isNaN(day) || day < 1 || day > 31) {
        addBotMessage('Invalid day. Please enter a number between 1 and 31.', false);
        setDisableInput(false);
        return;
      }

      setCronConfig(prev => ({ ...prev, day }));
      addBotMessage(`Day ${day} selected. What time? (Enter as HH:MM, e.g., 09:30)`, false);
      setCurrentStep('timeInput');
      setDisableInput(false);
    } else if (currentStep === 'timeInput') {
      const timeMatch = userInput.match(/^(\d{1,2}):(\d{2})$/);
      if (!timeMatch) {
        addBotMessage('Invalid time format. Please enter as HH:MM (e.g., 09:30).', false);
        setDisableInput(false);
        return;
      }

      const hour = parseInt(timeMatch[1]);
      const minute = parseInt(timeMatch[2]);

      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        addBotMessage('Invalid time. Hour must be 0-23, minute must be 0-59.', false);
        setDisableInput(false);
        return;
      }

      setCronConfig(prev => ({ ...prev, hour, minute }));

      // Update state first, then use the updated config
      const updatedConfig = { ...cronConfig, hour, minute };
      const description = getScheduleDescriptionFromConfig(updatedConfig);
      addBotMessage(`Schedule configured: ${description}. Click Save below.`, false);
      setSaveState(true);
      setCurrentStep('complete');
    } else if (currentStep === 'minuteInput') {
      const minute = parseInt(userInput) - 1;
      if (isNaN(minute) || minute < 0 || minute > 59) {
        addBotMessage('Invalid minute. Please enter a number between 0 and 59.', false);
        setDisableInput(false);
        return;
      }

      setCronConfig(prev => ({ ...prev, minute }));

      const updatedConfig = { ...cronConfig, minute };
      const description = getScheduleDescriptionFromConfig(updatedConfig);
      addBotMessage(`Schedule configured: ${description}. Click Save below.`, false);
      setSaveState(true);
      setCurrentStep('complete');
    }
  };

  const getScheduleDescriptionFromConfig = (config) => {
    const { frequency, month, day, dayOfWeek, hour, minute } = config;
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

    if (frequency === 'yearly') {
      return `Every year on ${monthNames[month - 1]} ${day} at ${hour}:${minute.toString().padStart(2, '0')}`;
    } else if (frequency === 'monthly') {
      return `Every month on day ${day} at ${hour}:${minute.toString().padStart(2, '0')}`;
    } else if (frequency === 'weekly') {
      return `Every ${dayNames[dayOfWeek]} at ${hour}:${minute.toString().padStart(2, '0')}`;
    } else if (frequency === 'daily') {
      return `Every day at ${hour}:${minute.toString().padStart(2, '0')}`;
    } else if (frequency === 'hourly') {
      return `Every hour at minute ${minute}`;
    }

    return 'Not configured';
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Save configuration
  // ─────────────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    try {
      setLoading(true);

      // Get previous configuration to check if we need to unregister old triggers
      const previousConfig = node?.data?.config;

      let config = {
        nodeType: 'start',
        triggerType
      };

      if (triggerType === 'manual') {
        // If switching to manual from a registered trigger, unregister it
        if (previousConfig && previousConfig.triggerType && previousConfig.triggerType !== 'manual') {
          console.log(`[StartNodeChat] Switching to manual, unregistering ${previousConfig.triggerType} trigger`);

          if (previousConfig.triggerType === 'time') {
            await window.electronAPI.startTriggers.unregisterCron({
              nodeId: node.id,
              workflowId: currentWorkflowId
            });
          } else if (previousConfig.triggerType === 'file') {
            await window.electronAPI.startTriggers.unregisterFileWatch({
              nodeId: node.id,
              workflowId: currentWorkflowId
            });
          }
        }
        config.description = 'Manual trigger';
      } else if (triggerType === 'time') {
        const cronExpression = buildCronExpression();
        if (!cronExpression) {
          message.error('Invalid CRON configuration');
          setLoading(false);
          return;
        }

        config.cronConfig = cronConfig;
        config.cronExpression = cronExpression;
        config.description = getScheduleDescription();

        // Unregister any previous trigger before registering CRON
        if (previousConfig && previousConfig.triggerType) {
          if (previousConfig.triggerType === 'time') {
            console.log('[StartNodeChat] Unregistering previous CRON job before registering new one');
            await window.electronAPI.startTriggers.unregisterCron({
              nodeId: node.id,
              workflowId: currentWorkflowId
            });
          } else if (previousConfig.triggerType === 'file') {
            console.log('[StartNodeChat] Switching from file watch to CRON, unregistering file watcher');
            await window.electronAPI.startTriggers.unregisterFileWatch({
              nodeId: node.id,
              workflowId: currentWorkflowId
            });
          }
        }

        // Register CRON job with backend
        const result = await window.electronAPI.startTriggers.registerCron({
          nodeId: node.id,
          workflowId: currentWorkflowId,
          cronExpression,
          description: config.description
        });

        if (!result.success) {
          message.error(`Failed to register schedule: ${result.message}`);
          setLoading(false);
          return;
        }
      } else if (triggerType === 'file') {
        if (!fileWatchConfig.path || fileWatchConfig.events.length === 0) {
          message.error('Please configure path and events');
          setLoading(false);
          return;
        }

        config.fileWatchConfig = fileWatchConfig;
        config.description = `Watch ${fileWatchConfig.type}: ${fileWatchConfig.path}`;

        // Unregister any previous trigger before registering file watcher
        if (previousConfig && previousConfig.triggerType) {
          if (previousConfig.triggerType === 'file') {
            console.log('[StartNodeChat] Unregistering previous file watcher before registering new one');
            await window.electronAPI.startTriggers.unregisterFileWatch({
              nodeId: node.id,
              workflowId: currentWorkflowId
            });
          } else if (previousConfig.triggerType === 'time') {
            console.log('[StartNodeChat] Switching from CRON to file watch, unregistering CRON job');
            await window.electronAPI.startTriggers.unregisterCron({
              nodeId: node.id,
              workflowId: currentWorkflowId
            });
          }
        }

        // Register file watcher with backend
        const result = await window.electronAPI.startTriggers.registerFileWatch({
          nodeId: node.id,
          workflowId: currentWorkflowId,
          path: fileWatchConfig.path,
          events: fileWatchConfig.events,
          pattern: fileWatchConfig.pattern
        });

        if (!result.success) {
          message.error(`Failed to register file watcher: ${result.message}`);
          setLoading(false);
          return;
        }
      }

      // Call onSave with config and current chat
      // NodeChatPanel's handleSave will add the summary message
      onSave(config, chat);

      setLoading(false);
      setSaveState(false);
      setHasUnsavedChanges(false); // Clear unsaved changes after successful save
      setCurrentStep('complete'); // Move to complete step to hide dropdown/buttons
      setPendingEventSelection(false);

    } catch (error) {
      console.error('Failed to save start node config:', error);
      message.error('Failed to save configuration');
      setLoading(false);
    }
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Format messages for ChatArea
  // ─────────────────────────────────────────────────────────────────────────

  const displayMessages = chat.map(m => ({
    id: m.id,
    text: m.text,
    metadata: m.metadata,
    sender: m.sender,
    timestamp: m.timestamp || new Date(),
  }));

  const formatTimestamp = (ts) => {
    const diff = Math.floor((Date.now() - new Date(ts)) / 60000);
    if (diff < 1) return 'Just now';
    if (diff < 60) return `${diff}m`;
    return `${Math.floor(diff / 60)}h`;
  };

  const getPlaceholder = () => {
    if (currentStep === 'dayInput') return 'Enter day (1-31)...';
    if (currentStep === 'timeInput') return 'Enter time (HH:MM)...';
    if (currentStep === 'minuteInput') return 'Enter minute (1-60)...';
    return 'Message...';
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────────────────────
  // Code popup wiring
  // ─────────────────────────────────────────────────────────────────────────
  const handleCodeSave = useCallback((field, value, message) => {
    setChat(prev => prev.map(m =>
      m.id === message?.id
        ? { ...m, metadata: { ...m.metadata, [field]: value } }
        : m
    ));
    if (!onConfigUpdate || !node?.id) return;
    onConfigUpdate(node.id, { [field]: value });
  }, [onConfigUpdate, node?.id]);

  return (
    <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
      <ChatArea
        hideHeader
        isFullscreen={false}
        currentChatTitle=""
        multiStepData={null}
        handleFullscreen={() => {}}
        handleToggleChat={() => {}}
        chatContainerRef={chatContainerRef}
        messages={displayMessages}
        isLoading={loading}
        progressInfo={{ progress: 0, stage: loading ? 'Processing...' : '' }}
        messagesEndRef={messagesEndRef}
        inputRef={inputRef}
        inputValue={inputValue}
        setInputValue={setInputValue}
        handleKeyPress={handleKeyPress}
        handleSendMessage={handleSendMessage}
        formatTimestamp={formatTimestamp}
        onSaveToMain={null}
        choices={displayChoices()}
        secondaryChoices={displayChoicesSecondary()}
        onChoiceSelect={handleChoiceClick}
        inputPlaceholder={getPlaceholder()}
        disableInput={disableInput}
        showRunButton={false}
        onRun={null}
        runButtonLoading={false}
        onCodeSave={handleCodeSave}
      />

    </div>
  );
};

export default StartNodeChat;
