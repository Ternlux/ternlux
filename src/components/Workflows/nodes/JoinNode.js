import React from 'react';
import { Handle, Position } from 'reactflow';
import { MergeOutlined } from '@ant-design/icons';

const JoinNode = ({ data, selected }) => {
  // Check if the join is configured (has sourcesConfig or joinSql)
  const isConfigured = !!(data.config?.sourcesConfig || data.config?.joinSql || data.config?.javascriptFunction);

  // Determine colors based on configuration status
  const borderColor = isConfigured ? '#fa8c16' : '#d9d9d9';
  const iconColor = isConfigured ? '#fa8c16' : '#999';
  const textColor = isConfigured ? '#333' : '#999';

  const getDisplayName = () => {
    const config = data.config;

    // Show target table/collection name if available
    if (config?.targetTableName) {
      return config.targetTableName;
    }
    if (config?.targetCollection) {
      return config.targetCollection;
    }

    // Fallback to node_name or label
    if (config?.node_name) {
      return config.node_name;
    }

    return data.label || 'Join';
  };

  const getSummary = () => {
    if (!isConfigured) return 'Click to configure join operation';

    const config = data.config;

    // Use explanation if available (from AI-generated join config)
    if (config?.explanation) {
      const explanation = config.explanation;
      return explanation.length > 100 ? explanation.slice(0, 100) + '...' : explanation;
    }

    // Build summary from join sources
    if (config?.sourcesConfig && config.sourcesConfig.length > 0) {
      const sourceCount = config.sourcesConfig.length;
      const targetName = config.targetTableName || config.targetCollection || 'result';
      return `Joining ${sourceCount} source${sourceCount > 1 ? 's' : ''} into ${targetName}`;
    }

    return 'Join operation configured';
  };

  return (
    <div className={`react-flow__node-join ${selected ? 'selected' : ''}`}
         style={{
           borderLeft: `4px solid ${borderColor}`,
           borderTop: `1px solid #e8e8e8`,
           borderRight: `1px solid #e8e8e8`,
           borderBottom: `2px solid #d0d0d0`,
           backgroundColor: '#fff7e6',
           boxShadow: selected ? '0 4px 12px rgba(0,0,0,0.15)' : '0 2px 6px rgba(0,0,0,0.1)',
           borderRadius: '2px',
           minWidth: '220px',
           maxWidth: '280px',
           opacity: isConfigured ? 1 : 0.8,
         }}>
      {/* Target handles for incoming connections */}
      <Handle
        type="target"
        position={Position.Left}
        id="input1"
        style={{
          background: borderColor,
          border: '2px solid #fff',
          width: '10px',
          height: '10px',
          left: '-5px',
          top: '30%'
        }}
      />

      <Handle
        type="target"
        position={Position.Left}
        id="input2"
        style={{
          background: borderColor,
          border: '2px solid #fff',
          width: '10px',
          height: '10px',
          left: '-5px',
          top: '70%'
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
        <MergeOutlined style={{ fontSize: '18px', color: iconColor }} />
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

export default JoinNode;