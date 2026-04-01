import React, { useState, useEffect } from 'react';
import { Card, Button, Row, Col, message, Spin, Tag, Empty, Modal } from 'antd';
import {
  DownloadOutlined,
  CheckCircleOutlined,
  DatabaseOutlined,
  ApiOutlined,
  LoadingOutlined
} from '@ant-design/icons';
import './PluginMarketplace.css';

const PluginMarketplace = () => {
  const [availablePlugins, setAvailablePlugins] = useState([]);
  const [installedPlugins, setInstalledPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState({});

  useEffect(() => {
    loadPlugins();
  }, []);

  const loadPlugins = async () => {
    setLoading(true);
    try {
      // Fetch available plugins from backend
      const response = await fetch('http://localhost:8000/api/plugins/available');
      const data = await response.json();

      if (data.success) {
        setAvailablePlugins(data.plugins || []);
      } else {
        message.error('Failed to load available plugins');
      }

      // Get installed plugins from electron
      if (window.electronAPI?.plugins?.listInstalled) {
        const installed = await window.electronAPI.plugins.listInstalled();
        if (installed.success) {
          setInstalledPlugins(installed.connectors || []);
        }
      }
    } catch (error) {
      console.error('Failed to load plugins:', error);
      message.error('Failed to connect to plugin server');
    } finally {
      setLoading(false);
    }
  };

  const isPluginInstalled = (pluginId) => {
    return installedPlugins.some(p => p.id === pluginId);
  };

  const handleInstall = async (plugin) => {
    Modal.confirm({
      title: `Install ${plugin.displayName}?`,
      content: `This will download and install the ${plugin.displayName} connector plugin. The plugin will be available after installation.`,
      okText: 'Install',
      cancelText: 'Cancel',
      onOk: async () => {
        setInstalling(prev => ({ ...prev, [plugin.id]: true }));

        try {
          if (!window.electronAPI?.plugins?.install) {
            message.error('Plugin installation not available');
            return;
          }

          const result = await window.electronAPI.plugins.install(plugin.id);

          if (result.success) {
            message.success(`${plugin.displayName} installed successfully!`);
            await loadPlugins(); // Reload to update installed status
          } else {
            message.error(`Failed to install plugin: ${result.message}`);
          }
        } catch (error) {
          console.error('Installation error:', error);
          message.error('Failed to install plugin');
        } finally {
          setInstalling(prev => ({ ...prev, [plugin.id]: false }));
        }
      }
    });
  };

  const handleUninstall = async (plugin) => {
    Modal.confirm({
      title: `Uninstall ${plugin.displayName}?`,
      content: `This will remove the ${plugin.displayName} connector plugin. Existing connections using this plugin may stop working.`,
      okText: 'Uninstall',
      okType: 'danger',
      cancelText: 'Cancel',
      onOk: async () => {
        setInstalling(prev => ({ ...prev, [plugin.id]: true }));

        try {
          if (!window.electronAPI?.plugins?.uninstall) {
            message.error('Plugin uninstallation not available');
            return;
          }

          const result = await window.electronAPI.plugins.uninstall(plugin.id);

          if (result.success) {
            message.success(`${plugin.displayName} uninstalled successfully!`);
            await loadPlugins(); // Reload to update installed status
          } else {
            message.error(`Failed to uninstall plugin: ${result.message}`);
          }
        } catch (error) {
          console.error('Uninstallation error:', error);
          message.error('Failed to uninstall plugin');
        } finally {
          setInstalling(prev => ({ ...prev, [plugin.id]: false }));
        }
      }
    });
  };

  const getPluginIcon = (type) => {
    switch (type) {
      case 'connector':
        return <DatabaseOutlined style={{ fontSize: 32, color: '#1890ff' }} />;
      case 'transformation':
        return <ApiOutlined style={{ fontSize: 32, color: '#52c41a' }} />;
      default:
        return <DatabaseOutlined style={{ fontSize: 32, color: '#1890ff' }} />;
    }
  };

  if (loading) {
    return (
      <div className="plugin-marketplace-loading">
        <Spin size="large" />
        <p>Loading plugins...</p>
      </div>
    );
  }

  return (
    <div className="plugin-marketplace">
        <h2>Plugin Marketplace</h2>
        <div className="plugin-marketplace-header">
        <p>Browse and install connector plugins to extend DagFlux functionality</p>
        <Button onClick={loadPlugins} loading={loading}>
          Refresh
        </Button>
      </div>

      {availablePlugins.length === 0 ? (
        <Empty
          description="No plugins available"
          style={{ marginTop: 60 }}
        />
      ) : (
        <Row gutter={[16, 16]} className="plugin-grid">
          {availablePlugins.map((plugin) => {
            const installed = isPluginInstalled(plugin.id);
            const isInstalling = installing[plugin.id];

            return (
              <Col xs={24} sm={12} lg={8} xl={6} key={plugin.id}>
                <Card
                  className={`plugin-card ${installed ? 'plugin-installed' : ''}`}
                  hoverable={!installed}
                >
                  <div className="plugin-card-header">
                    {getPluginIcon(plugin.type)}
                    {installed && (
                      <Tag color="success" icon={<CheckCircleOutlined />}>
                        Installed
                      </Tag>
                    )}
                  </div>

                  <div className="plugin-card-content">
                    <h3>{plugin.displayName}</h3>
                    <p className="plugin-description">{plugin.description}</p>

                    <div className="plugin-meta">
                      <span className="plugin-version">v{plugin.version}</span>
                      <Tag>{plugin.type}</Tag>
                    </div>

                    {plugin.author && (
                      <p className="plugin-author">By {plugin.author}</p>
                    )}
                  </div>

                  <div className="plugin-card-footer">
                    {installed ? (
                      <Button
                        danger
                        block
                        onClick={() => handleUninstall(plugin)}
                        loading={isInstalling}
                      >
                        Uninstall
                      </Button>
                    ) : (
                      <Button
                        type="primary"
                        icon={isInstalling ? <LoadingOutlined /> : <DownloadOutlined />}
                        block
                        onClick={() => handleInstall(plugin)}
                        loading={isInstalling}
                      >
                        Install
                      </Button>
                    )}
                  </div>
                </Card>
              </Col>
            );
          })}
        </Row>
      )}
    </div>
  );
};

export default PluginMarketplace;
