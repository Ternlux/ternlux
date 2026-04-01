import React from 'react';
import { Handle, Position } from 'reactflow';
import { MailOutlined, ExportOutlined, RobotOutlined, BulbOutlined } from '@ant-design/icons';

const OutputNode = ({ data, selected }) => {
  // Check if the output is configured (new structure with outputSettings)
  const isConfigured = !!(data.config?.outputSettings?.outputType);

  // Determine colors based on configuration status
  const borderColor = isConfigured ? '#722ed1' : '#d9d9d9';
  const iconColor = isConfigured ? '#722ed1' : '#999';
  const textColor = isConfigured ? '#333' : '#999';

  // Get display information
  const getDisplayName = () => {
    const outputSettings = data.config?.outputSettings;

    if (!outputSettings?.outputType) {
      return 'Output';
    }

    if (outputSettings.outputType === 'local') {
      // Show format for local output
      const format = outputSettings.format?.toUpperCase() || 'FILE';
      return `Export to ${format}`;
    } else if (outputSettings.outputType === 'connection') {
      // Show connection for database output
      return outputSettings.tableName || 'Database Export';
    }

    return 'Output';
  };

  const getOutputIcon = () => {
    const outputSettings = data.config?.outputSettings;

    if (!outputSettings?.outputType) {
      return <ExportOutlined style={{ fontSize: '18px', color: iconColor }} />;
    }

    if (outputSettings.outputType === 'local') {
      return <ExportOutlined style={{ fontSize: '18px', color: iconColor }} />;
    } else if (outputSettings.outputType === 'connection') {
      return <MailOutlined style={{ fontSize: '18px', color: iconColor }} />;
    }

    return <ExportOutlined style={{ fontSize: '18px', color: iconColor }} />;
  };

  const getSummary = () => {
    if (!isConfigured) return 'Click to configure output';

    const outputSettings = data.config?.outputSettings;

    if (outputSettings.outputType === 'local') {
      const format = outputSettings.format?.toUpperCase() || 'file';
      const fileName = outputSettings.savePath ? outputSettings.savePath.split('/').pop() : 'output file';
      return `Export data to ${format} file: ${fileName}`;
    } else if (outputSettings.outputType === 'connection') {
      const connectionName = data.config?.sourceConnectionName || 'database';
      return `Insert data into ${outputSettings.tableName} (${connectionName})`;
    }

    return 'Output configured';
  };

  return (
    <div className={`react-flow__node-output ${selected ? 'selected' : ''}`}
         style={{
           borderLeft: `4px solid ${borderColor}`,
           borderTop: `1px solid #e8e8e8`,
           borderRight: `1px solid #e8e8e8`,
           borderBottom: `2px solid #d0d0d0`,
           backgroundColor: '#f9f0ff',
           boxShadow: selected ? '0 4px 12px rgba(0,0,0,0.15)' : '0 2px 6px rgba(0,0,0,0.1)',
           borderRadius: '2px',
           minWidth: '220px',
           maxWidth: '280px',
           opacity: isConfigured ? 1 : 0.8,
         }}>
      {/* Target handle for incoming connections */}
      <Handle
        type="target"
        position={Position.Left}
        style={{
          background: borderColor,
          border: '2px solid #fff',
          width: '10px',
          height: '10px',
          left: '-5px',
        }}
      />

      {/* Header with icon and name */}
      <div style={{
        padding: '10px 12px',
        borderBottom: '1px solid #f0f0f0',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        backgroundColor: 'rgba(255,255,255,0.5)',
      }}>
        {getOutputIcon()}
        <div style={{
          fontWeight: '600',
          fontSize: '13px',
          color: textColor,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {getDisplayName()}
        </div>
      </div>

      {/* Summary description */}
      <div style={{
        padding: '12px',
        fontSize: '12px',
        lineHeight: '1.5',
        color: isConfigured ? '#555' : '#999',
        fontStyle: isConfigured ? 'normal' : 'italic',
        minHeight: '60px',
        maxHeight: '90px',
        overflow: 'hidden',
        display: '-webkit-box',
        WebkitLineClamp: 4,
        WebkitBoxOrient: 'vertical',
      }}>
        {getSummary()}
      </div>
    </div>
  );
};

export default OutputNode;