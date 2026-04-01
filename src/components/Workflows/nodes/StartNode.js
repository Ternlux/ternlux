import React from 'react';
import { Handle, Position } from 'reactflow';
import { PlayCircleOutlined, ClockCircleOutlined, ThunderboltOutlined } from '@ant-design/icons';

const StartNode = ({ data, selected }) => {
  const getTriggerIcon = () => {
    switch (data.config?.triggerType) {
      case 'schedule':
        return <ClockCircleOutlined style={{ fontSize: '14px', color: 'white' }} />;
      case 'webhook':
        return <ThunderboltOutlined style={{ fontSize: '14px', color: 'white' }} />;
      default:
        return <PlayCircleOutlined style={{ fontSize: '14px', color: 'white' }} />;
    }
  };

  const getTriggerLabel = () => {
    const config = data.config || {};
    switch (config.triggerType) {
      case 'schedule':
        return config.scheduleType || 'Schedule';
      case 'webhook':
        return 'Webhook';
      case 'manual':
        return 'Manual';
      default:
        return 'Start';
    }
  };

  const getTriggerDescription = () => {
    const config = data.config || {};
    switch (config.triggerType) {
      case 'schedule':
        if (config.scheduleType === 'interval' && config.interval) {
          return `Every ${config.interval}${config.intervalUnit?.charAt(0) || 'm'}`;
        } else if (config.scheduleType === 'daily') {
          return 'Daily';
        } else if (config.scheduleType === 'weekly') {
          return 'Weekly';
        } else if (config.scheduleType === 'monthly') {
          return 'Monthly';
        } else if (config.scheduleType === 'cron') {
          return 'Custom';
        }
        return 'Configure';
      case 'webhook':
        return 'API Trigger';
      case 'manual':
        return 'Manual';
      default:
        return 'Configure';
    }
  };

  return (
    <div className={`react-flow__node-start ${selected ? 'selected' : ''}`}>
      <div style={{ 
        padding: '8px 10px', 
        display: 'flex', 
        alignItems: 'center', 
        gap: '6px',
        width: '240px',
        background: 'linear-gradient(135deg, #1890ff 0%, #40a9ff 100%)',
        color: 'white',
        borderRadius: '6px',
        position: 'relative'
      }}>
        {getTriggerIcon()}
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: '500', fontSize: '12px' }}>
            {getTriggerLabel()}
          </div>
          <div style={{ fontSize: '10px', opacity: 0.9 }}>
            {getTriggerDescription()}
          </div>
        </div>
        
        {/* Start indicator */}
        <div style={{
          position: 'absolute',
          top: '-4px',
          left: '-4px',
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: '#52c41a',
          border: '1px solid white'
        }} />
      </div>
      
      <Handle
        type="source"
        position={Position.Right}
        style={{
          background: '#1890ff',
          border: '2px solid #fff',
          width: '8px',
          height: '8px'
        }}
      />
    </div>
  );
};

export default StartNode;