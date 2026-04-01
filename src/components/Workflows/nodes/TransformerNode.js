import React from 'react';
import { Handle, Position } from 'reactflow';
import { SettingOutlined, CheckCircleOutlined, ExclamationCircleOutlined } from '@ant-design/icons';

const TransformerNode = ({ data, selected }) => {
  // Check if the transformer is configured (has SQL or transformation request)
  const isConfigured = !!(data.config?.sql || data.config?.transformationRequest);
  // console.log('TransformerNode data: ', data)

  // Determine colors based on configuration status
  const borderColor = isConfigured ? '#1890ff' : '#d9d9d9';
  const iconColor = isConfigured ? '#1890ff' : '#999';
  const textColor = isConfigured ? '#333' : '#999';

  // Get display information
  const getDisplayName = () => {
    // If node has a custom name, use it
    if (data.config?.node_name) {
      return data.config.node_name;
    }

    // Show targetDbType if available, otherwise fall back to label or 'Transformer'
    const dbType = data.config?.targetDbType;
    if (dbType) {
      return dbType.charAt(0).toUpperCase() + dbType.slice(1);
    }

    return data.label || 'Transformer';
  };

  const getSummary = () => {
    if (!isConfigured) return 'Click to configure transformation';

    const config = data.config;

    // Use SQL explanation if available
    if (config.sqlExplanation || config.explanation) {
      const explanation = config.sqlExplanation || config.explanation;
      return explanation.length > 100 ? explanation.slice(0, 100) + '...' : explanation;
    }

    // Use transformation request
    if (config.transformationRequest) {
      const request = config.transformationRequest;
      return request.length > 100 ? request.slice(0, 100) + '...' : request;
    }

    // Fallback
    if (config.sql) {
      return 'Transformation configured';
    }

    return 'Click to configure transformation';
  };

  return (
    <div className={`react-flow__node-transformer ${selected ? 'selected' : ''}`}
         style={{
           borderLeft: `4px solid ${borderColor}`,
           borderTop: `1px solid #e8e8e8`,
           borderRight: `1px solid #e8e8e8`,
           borderBottom: `2px solid #d0d0d0`,
           backgroundColor: '#e6f7ff',
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
        {isConfigured ? (
          <CheckCircleOutlined style={{ fontSize: '18px', color: iconColor }} />
        ) : (
          <SettingOutlined style={{ fontSize: '18px', color: iconColor }} />
        )}
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

      {/* Source handle for outgoing connections */}
      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: borderColor,
          border: '2px solid #fff',
          width: '10px',
          height: '10px',
          right: '-5px',
        }}
      />
    </div>
  );
};

export default TransformerNode;