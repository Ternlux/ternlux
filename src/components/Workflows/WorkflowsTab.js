import React, { useState, useEffect, useRef } from 'react';
import { Button, Card, List, Typography, Space, Tag, Dropdown, Menu, Modal, message, Spin } from 'antd';
import { 
  PlusOutlined, 
  EditOutlined, 
  DeleteOutlined, 
  ApartmentOutlined,
  PlayCircleOutlined, 
  MoreOutlined,
  CalendarOutlined,
  UserOutlined,
  UploadOutlined
} from '@ant-design/icons';
import WorkflowEditor from './WorkflowEditor';
import DataSourceUpload from './DataSourceUpload';
import axios from 'axios';
import moment from 'moment';
import { workflowsDb } from '../../utils/localDb';

const { Title, Text } = Typography;

const WorkflowsTab = () => {
  const [workflows, setWorkflows] = useState([]);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false);
  const [uploadedDataSource, setUploadedDataSource] = useState(null);
  const workflowCloseHandlerRef = useRef(null);

  const handleAuthError = (error) => {
    if (error.response?.status === 401 || error.response?.status === 204 || 
        (error.response?.status === 400)) {
      localStorage.removeItem('auth-token');
      message.error('Session expired. Please log in again.');
      window.location.href = '/login';
      return true;
    }
    return false;
  };
  // Load workflows from API
  useEffect(() => {
    fetchWorkflows();
  }, []);

  const fetchWorkflows = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('auth-token');

      if (token) {

        const response = await axios.get('/workflow/workflows', {
          headers: { 'auth-token': token }
        });
  
        if (response.data.success) {
          const workflowsData = response.data.data.workflows.map(workflow => ({
            ...workflow,
            createdAt: moment(workflow.createdAt),
            lastRun: workflow.lastExecuted ? moment(workflow.lastExecuted) : null,
            updatedAt: moment(workflow.updatedAt)
          }));
          setWorkflows(workflowsData);
        }
      }
      // No session — load from local NeDB storage
      const localWorkflows = await workflowsDb.getAll();
      console.log('localWorkflows: ', localWorkflows)
      setWorkflows(localWorkflows.map(workflow => ({
        ...workflow,
        createdAt: moment(workflow.createdAt),
        lastRun: workflow.lastExecuted ? moment(workflow.lastExecuted) : null,
        updatedAt: moment(workflow.updatedAt),
      })));

    } catch (error) {
      if (handleAuthError(error)) return;
      console.error('Error fetching workflows:', error);
      message.error('Failed to load workflows');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateWorkflow = () => {
    setEditingWorkflow(null);
    setIsEditorOpen(true);
  };

  const handleCreateFromDataSource = () => {
    setIsUploadModalOpen(true);
  };

  const handleEditWorkflow = (workflow) => {
    setEditingWorkflow(workflow);
    setIsEditorOpen(true);
  };

  const handleDeleteWorkflow = async (workflowId) => {
    Modal.confirm({
      title: 'Delete Workflow',
      content: 'Are you sure you want to delete this workflow? This action cannot be undone.',
      okText: 'Delete',
      okType: 'danger',
      cancelText: 'Cancel',
      async onOk() {
        try {
          const token = localStorage.getItem('auth-token');

          if (token) {
            // User is logged in - delete from API
            const response = await axios.post('/workflow/workflow-action', {
              action: 'delete',
              workflowId: workflowId
            }, {
              headers: {
                'auth-token': token
              }
            });

            if (response.data.success) {
              setWorkflows(prev => prev.filter(w => w.id !== workflowId));
              message.success('Workflow deleted successfully');
            }
          } else {
            // User is not logged in - delete from local database
            await workflowsDb.delete(workflowId);
            setWorkflows(prev => prev.filter(w => w.id !== workflowId));
            message.success('Workflow deleted locally');
          }
        } catch (error) {
          if (handleAuthError(error)) return;
          console.error('Error deleting workflow:', error);
          message.error('Failed to delete workflow');
        }
      },
    });
  };

  const handleRunWorkflow = async (workflowId) => {
    try {
      const response = await axios.post('/executions', {
        workflowId,
        trigger: { type: 'manual' }
      }, {
        headers: {
          'auth-token': localStorage.getItem('auth-token')
        }
      });

      if (response.data.success) {
        message.success('Workflow execution started');
        // Refresh workflows to update execution count
        fetchWorkflows();
      }
    } catch (error) {
      if (handleAuthError(error)) return;
      console.error('Error running workflow:', error);
      message.error('Failed to start workflow execution');
    }
  };

  const handleSaveWorkflow = async (workflowData) => {
    try {
      const token = localStorage.getItem('auth-token');

      if (token) {
        // User is logged in - save to API
        let response;

        if (editingWorkflow) {
          // Update existing workflow
          response = await axios.post('/workflow/workflow-action', {
            action: 'update',
            workflowId: editingWorkflow.id,
            ...workflowData
          }, {
            headers: {
              'auth-token': token
            }
          });

          if (response.data.success) {
            message.success('Workflow updated successfully');
          } else {
            throw new Error(response.data.error || 'Failed to update workflow');
          }
        } else {
          // Create new workflow
          const newWorkflowData = {
            ...workflowData,
            ...(uploadedDataSource && {
              connectionId: uploadedDataSource.connectionId
            })
          };

          response = await axios.post('/workflow/workflow-save', newWorkflowData, {
            headers: {
              'auth-token': token
            }
          });

          if (response.data.success) {
            message.success('Workflow created successfully');
          } else {
            throw new Error(response.data.error || 'Failed to create workflow');
          }
        }
      } else {
        // User is not logged in - save to local database
        if (editingWorkflow) {
          // Update existing workflow locally
          await workflowsDb.update(editingWorkflow.id, workflowData);
          message.success('Workflow updated locally');
        } else {
          // Create new workflow locally
          const newWorkflow = {
            ...workflowData,
            ...(uploadedDataSource && {
              connectionId: uploadedDataSource.connectionId
            })
          };
          await workflowsDb.save(newWorkflow);
          message.success('Workflow created locally');
        }
      }

      // Refresh the workflow list
      await fetchWorkflows();

      // Close editor and cleanup
      setIsEditorOpen(false);
      setEditingWorkflow(null);
      setUploadedDataSource(null);

    } catch (error) {
      if (handleAuthError(error)) return;
      console.error('Error saving workflow:', error);
      message.error('Failed to save workflow');
      throw error; // Re-throw so the editor can handle the error state
    }
  };

  const handleUploadComplete = (uploadResult) => {
    setUploadedDataSource(uploadResult);
    setIsUploadModalOpen(false);
    setIsEditorOpen(true);
    message.success('Data source uploaded! Now create your workflow.');
  };

  const handleModalClose = () => {
    if (workflowCloseHandlerRef.current) {
      // Use the workflow's own close handler which checks for unsaved changes
      workflowCloseHandlerRef.current();
    } else {
      // Fallback to direct close
      handleWorkflowClose();
    }
  };

  const handleWorkflowClose = () => {
    setIsEditorOpen(false);
    setEditingWorkflow(null);
    setUploadedDataSource(null);
    workflowCloseHandlerRef.current = null;
  };

  const registerWorkflowCloseHandler = (handler) => {
    workflowCloseHandlerRef.current = handler;
  };

  const getWorkflowMenu = (workflow) => (
    <Menu>
      <Menu.Item 
        key="run" 
        icon={<PlayCircleOutlined />} 
        onClick={() => handleRunWorkflow(workflow.id)}
      >
        Run Workflow
      </Menu.Item>
      <Menu.Item 
        key="edit" 
        icon={<EditOutlined />} 
        onClick={() => handleEditWorkflow(workflow)}
      >
        Edit Workflow
      </Menu.Item>
      <Menu.Divider />
      <Menu.Item 
        key="delete" 
        icon={<DeleteOutlined />} 
        danger
        onClick={() => handleDeleteWorkflow(workflow.id)}
      >
        Delete Workflow
      </Menu.Item>
    </Menu>
  );

  return (
    <div className="workflows-container">
      <div className="workflows-header">
        <div>
          <Title level={4} style={{ margin: 0 }}>
            Workflows
          </Title>
          <Text type="secondary">
            Create and manage your data processing workflows
          </Text>
        </div>
        <Space>
          <Button 
            type="primary" 
            icon={<PlusOutlined />} 
            size="large"
            onClick={handleCreateWorkflow}
          >
            Create Workflow
          </Button>
        </Space>
      </div>

      <div className="workflows-content">
        {loading ? (
          <div style={{ textAlign: 'center', padding: '50px' }}>
            <Spin size="large" />
            <div style={{ marginTop: '16px' }}>
              <Text type="secondary">Loading workflows...</Text>
            </div>
          </div>
        ) : workflows.length === 0 ? (
          <div className="empty-state">
            <Title level={4} type="secondary">
              No workflows created yet
            </Title>
            <Text type="secondary" style={{ marginBottom: '24px', display: 'block' }}>
              Create a connection and create your first workflow to start processing data
            </Text>
          </div>
        ) : (
          <div className="workflow-list">
            <List
              grid={{ gutter: 16, xs: 1, sm: 1, md: 2, lg: 2, xl: 3 }}
              dataSource={workflows}
              renderItem={(workflow) => (
                <List.Item>
                  <Card
                    className="workflow-card"
                    title={
                      <div className="workflow-card-header">
                        <span 
                          className="workflow-name"
                          title={workflow.name}
                        >
                          {workflow.name}
                        </span>
                        <div style={{ marginLeft: '10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {/* <Tag 
                            color={workflow.status === 'active' ? 'green' : 'orange'}
                            className={`workflow-status ${workflow.status}`}
                          >
                            {workflow.status}
                          </Tag> */}
                          <Dropdown 
                            overlay={getWorkflowMenu(workflow)} 
                            trigger={['click']}
                            placement="bottomRight"
                          >
                            <Button 
                              type="text" 
                              icon={<MoreOutlined />} 
                              size="small" 
                              onClick={(e) => e.stopPropagation()}
                            />
                          </Dropdown>
                        </div>
                      </div>
                    }
                    onClick={() => handleEditWorkflow(workflow)}
                  >
                    <div className="workflow-description">
                      <Text type="secondary">{workflow.description}</Text>
                    </div>
                    
                    <div className="workflow-meta">
                      <span style={{ display: 'flex', alignItems: 'center' }}>

                        {workflow.nodeCount} nodes
                      </span>
                      <span>
                        <UserOutlined style={{ marginRight: '4px' }} />
                        {workflow.createdBy}
                      </span>
                      <span>
                        <CalendarOutlined style={{ marginRight: '4px' }} />
                        {workflow.createdAt.format('MMM DD')}
                      </span>
                    </div>

                    {workflow.lastRun && (
                      <div style={{ marginTop: '8px', fontSize: '12px', color: '#666' }}>
                        Last run: {workflow.lastRun.fromNow()}
                      </div>
                    )}

                    <div style={{ marginTop: '12px' }}>
                      <Tag color="blue">{workflow.type}</Tag>
                    </div>
                  </Card>
                </List.Item>
              )}
            />
          </div>
        )}
      </div>

      <Modal
        title={editingWorkflow ? 'Edit Workflow' : 'Create New Workflow'}
        open={isEditorOpen}
        onCancel={handleModalClose}
        footer={null}
        width="95%"
        style={{ top: 50 }}
        bodyStyle={{ height: 'calc(100vh - 120px)', padding: 0 }}
        destroyOnClose
        maskClosable={false}
      >
        <WorkflowEditor
          workflow={editingWorkflow}
          dataSource={uploadedDataSource}
          onSave={handleSaveWorkflow}
          onCancel={handleWorkflowClose}
          onCloseRequest={registerWorkflowCloseHandler}
        />
      </Modal>

    </div>
  );
};

export default WorkflowsTab;