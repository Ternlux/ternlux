import React, { useState, useEffect } from 'react';
import { message, Modal, Select } from 'antd';

const { Option } = Select;

/**
 * Google Drive Picker Component
 * Handles Google Picker integration for selecting files from Google Drive
 */
const GoogleDrivePicker = ({ connection, onFileSelect, onClose }) => {
  const [pickerCredentials, setPickerCredentials] = useState(null);
  const [loadingPicker, setLoadingPicker] = useState(false);
  const [downloadingFile, setDownloadingFile] = useState(false);
  const [processingFile, setProcessingFile] = useState(false);
  const [availableSheets, setAvailableSheets] = useState([]);
  const [selectedSheet, setSelectedSheet] = useState(null);
  const [selectedFile, setSelectedFile] = useState(null);
  const [filePreview, setFilePreview] = useState(null);

  // Load Google Picker API
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = () => {
      window.gapi.load('picker', () => {
        console.log('Google Picker API loaded');
      });
    };
    document.body.appendChild(script);

    return () => {
      // Cleanup script on unmount
      const scripts = document.querySelectorAll('script[src="https://apis.google.com/js/api.js"]');
      scripts.forEach(s => s.remove());
    };
  }, []);

  // Load picker credentials when component mounts
  useEffect(() => {
    if (connection) {
      loadPickerCredentials();
    }
  }, [connection]);

  // Auto-open picker when credentials are loaded
  useEffect(() => {
    if (pickerCredentials && window.google?.picker) {
      // Small delay to ensure everything is ready
      const timer = setTimeout(() => {
        openGooglePicker();
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [pickerCredentials]);

  const loadPickerCredentials = async () => {
    setLoadingPicker(true);
    try {
      const result = await window.electronAPI.cloudStorage.getPickerCredentials(
        connection.id,
        connection.dbType
      );

      if (result.success) {
        setPickerCredentials({
          accessToken: result.accessToken,
          apiKey: result.apiKey,
          clientId: result.clientId
        });
      } else {
        message.error('Failed to load Google Picker: ' + result.message);
      }
    } catch (error) {
      console.error('Error loading picker credentials:', error);
      message.error('Failed to load Google Picker');
    } finally {
      setLoadingPicker(false);
    }
  };

  const openGooglePicker = () => {
    if (!pickerCredentials) return;

    const google = window.google;
    if (!google || !google.picker) {
      message.error('Google Picker API not loaded');
      return;
    }

    const pickerBuilder = new google.picker.PickerBuilder()
      .addView(google.picker.ViewId.DOCS)
      .setOAuthToken(pickerCredentials.accessToken)
      .setCallback(handlePickerCallback);

    // Set developer key if available (optional with OAuth)
    if (pickerCredentials.apiKey) {
      pickerBuilder.setDeveloperKey(pickerCredentials.apiKey);
    }

    const picker = pickerBuilder.build();
    picker.setVisible(true);
  };

  const handlePickerCallback = async (data) => {
    if (data.action === window.google.picker.Action.PICKED) {
      const doc = data.docs[0];

      // Check if it's a Google Workspace file that needs export
      const isGoogleWorkspaceFile = doc.mimeType && doc.mimeType.startsWith('application/vnd.google-apps.');

      if (isGoogleWorkspaceFile) {
        // Handle Google Workspace files (Sheets, Docs, etc.)
        handleGoogleWorkspaceFile(doc);
      } else {
        // Regular file - download normally
        downloadFile(doc);
      }
    }
  };

  const handleGoogleWorkspaceFile = async (doc) => {
    // For now, only support Google Sheets
    if (doc.mimeType === 'application/vnd.google-apps.spreadsheet') {
      message.info('Exporting Google Sheet to Excel format...');
      // Download will be handled by exportObject instead of downloadObject
      setDownloadingFile(true);
      try {
        const result = await window.electronAPI.cloudStorage.exportObject(
          connection.id,
          connection.dbType,
          doc.id,
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' // Export as Excel
        );

        if (result.success) {
          // Add .xlsx extension if not present
          const fileName = doc.name.endsWith('.xlsx') ? doc.name : `${doc.name}.xlsx`;
          await processDownloadedFile(fileName, result.data, result.contentType || result.mimeType);
        } else {
          message.error('Failed to export Google Sheet: ' + result.message);
        }
      } catch (error) {
        console.error('Error exporting Google Sheet:', error);
        message.error('Failed to export Google Sheet');
      } finally {
        setDownloadingFile(false);
      }
    } else {
      message.error(`Google ${doc.mimeType.replace('application/vnd.google-apps.', '')} files are not supported yet. Please use native Excel, CSV, or JSON files.`);
      onClose();
    }
  };

  const downloadFile = async (doc) => {
    setDownloadingFile(true);
    try {
      const result = await window.electronAPI.cloudStorage.downloadObject(
        connection.id,
        connection.dbType,
        'root', // containerName not used for Google Drive with picker
        doc.id // Use file ID from picker
      );

      if (result.success) {
        // Process the downloaded file
        await processDownloadedFile(doc.name, result.data, result.contentType || result.mimeType);
      } else {
        message.error('Failed to download file: ' + result.message);
      }
    } catch (error) {
      console.error('Error downloading file:', error);
      message.error('Failed to download file');
    } finally {
      setDownloadingFile(false);
    }
  };

  const processDownloadedFile = async (fileName, data, contentType) => {
    const fileExtension = fileName.split('.').pop().toLowerCase();
    const localFileType = getLocalFileType(fileName);

    // Check if file type is supported
    if (!checkFileType({ name: fileName })) {
      message.error(`Unsupported file type: ${fileExtension}`);
      return;
    }

    if (!localFileType) {
      message.error('Unsupported file type');
      return;
    }

    // Create a temporary file object for metadata
    const fileObject = { name: fileName, data, contentType };

    // For Excel files, analyze sheets
    if (['xlsx', 'xls'].includes(fileExtension)) {
      try {
        const sheetResult = await window.electronAPI.cloudStorage.analyzeExcelFile(data);
        if (sheetResult.success && sheetResult.sheets.length > 0) {
          if (sheetResult.sheets.length > 1) {
            // Multiple sheets - let user select
            setAvailableSheets(sheetResult.sheets);
            setSelectedFile(fileObject);
            setFilePreview({ type: 'excel-multisheet', data, fileName });
            setProcessingFile(false);
            message.info('This Excel file has multiple sheets. Please select one.');
            return;
          } else {
            // Single sheet - import directly
            setSelectedFile(fileObject);
            setProcessingFile(true);
            await importFileToLocal(data, fileName, localFileType, sheetResult.sheets[0]);
            return;
          }
        }
      } catch (error) {
        console.error('Excel analysis error:', error);
      }
    }

    // Import the file directly for non-Excel files
    setSelectedFile(fileObject);
    setProcessingFile(true);
    await importFileToLocal(data, fileName, localFileType, null);
  };

  const importFileToLocal = async (fileData, fileName, fileType, sheetName) => {
    try {
      // Call electron API to import file to local SQLite/NeDB
      if (!window.electronAPI?.cloudStorage?.importFile) {
        message.error('Cloud storage import not available');
        return;
      }

      const result = await window.electronAPI.cloudStorage.importFile({
        data: fileData,
        fileName: fileName,
        fileType: fileType,
        sheetName: sheetName,
        containerName: 'root',
        connectionName: connection.name
      });

      if (result.success) {
        message.success('File imported successfully!');

        // Include sheet name in file name if provided
        const displayFileName = sheetName
          ? `${fileName} (${sheetName})`
          : fileName;

        // Return the imported file info to parent component
        onFileSelect({
          fileName: displayFileName,
          localPath: result.localPath,
          dbType: result.dbType, // 'sqlite' or 'nedb'
          tables: result.tables,
          sheetName: sheetName, // Pass sheet name for reference
          schemas: result.schemas || result.schema, // Pass schema(s) from import
          cloudSource: {
            connectionId: connection.id,
            connectionName: connection.name,
            containerName: 'root',
            objectName: fileName,
            objectPath: fileName
          }
        });

        onClose();
      } else {
        message.error('Failed to import file: ' + result.message);
      }
    } catch (error) {
      console.error('Error importing file:', error);
      message.error('Failed to import file');
    } finally {
      setProcessingFile(false);
    }
  };

  const handleSheetSelection = async (sheetName) => {
    setSelectedSheet(sheetName);
    if (filePreview && filePreview.type === 'excel-multisheet') {
      setProcessingFile(true);
      await importFileToLocal(filePreview.data, filePreview.fileName, 'spreadsheet', sheetName);
    }
  };

  const isSupportedFileType = (fileName) => {
    const name = fileName.toLowerCase();
    const supportedTypes = ['.csv', '.xlsx', '.xls', '.json', '.sqlite', '.db', '.parquet', '.avro', '.nedb'];
    return supportedTypes.some(ext => name.endsWith(ext));
  };

  const checkFileType = (file) => {
    const isSupported = isSupportedFileType(file.name);

    if (!isSupported) {
      message.warning('This file type is not supported. Please select CSV, Excel, JSON, SQLite, Parquet, Avro, or NeDB files.');
      return false;
    }
    return true;
  };

  const getLocalFileType = (fileName) => {
    const name = fileName.toLowerCase();
    if (name.endsWith('.csv') || name.endsWith('.xlsx') || name.endsWith('.xls')) return 'spreadsheet';
    if (name.endsWith('.json')) return 'json';
    if (name.endsWith('.sqlite') || name.endsWith('.db')) return 'sqlite';
    if (name.endsWith('.nedb')) return 'nedb';
    if (name.endsWith('.parquet')) return 'parquet';
    if (name.endsWith('.avro')) return 'avro';
    return null;
  };

  // Show sheet selection modal if needed
  const showSheetSelectionModal = () => {
    Modal.confirm({
      title: 'Select Excel Sheet',
      content: (
        <Select
          placeholder="Choose a sheet"
          style={{ width: '100%', marginTop: 16 }}
          onChange={(value) => {
            setSelectedSheet(value);
            Modal.destroyAll();
            handleSheetSelection(value);
          }}
        >
          {availableSheets.map(sheet => (
            <Option key={sheet} value={sheet}>{sheet}</Option>
          ))}
        </Select>
      ),
      okButtonProps: { style: { display: 'none' } },
      cancelText: 'Cancel',
      onCancel: () => {
        onClose();
      }
    });
  };

  // Show sheet selection modal when available
  useEffect(() => {
    if (availableSheets.length > 1) {
      showSheetSelectionModal();
    }
  }, [availableSheets]);

  return null;
};

export default GoogleDrivePicker;
