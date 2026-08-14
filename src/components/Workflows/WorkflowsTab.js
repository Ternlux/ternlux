import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Modal, message, Spin } from 'antd';
import WorkflowEditor from './WorkflowEditor';
import axios from 'axios';
import moment from 'moment';
import { workflowsDb, connectionsDb } from '../../utils/localDb';
import {
  C, MONO, Btn, Tag, MetaItem, MoreMenu, PageHeader, fullscreenModalProps,
} from './_designShared';
import { collectDroppableFiles, fileDragHandlers, FileDropOverlay } from './connections/localFileDrop';

const TYPE_COLORS = {
  transformation: { color: C.accent,  bg: C.aD,                       border: 'rgba(37,99,235,0.18)' },
  aggregation:    { color: C.violet,  bg: C.vD,                       border: 'rgba(124,58,237,0.18)' },
  reconciliation: { color: C.amber,   bg: C.amD,                      border: 'rgba(217,119,6,0.18)' },
  'ml-prep':      { color: C.cyan,    bg: C.cD,                       border: 'rgba(8,145,178,0.18)' },
  etl:            { color: C.green,   bg: C.gD,                       border: 'rgba(5,150,105,0.18)' },
  cleaning:       { color: '#db2777', bg: 'rgba(219,39,119,0.06)',    border: 'rgba(219,39,119,0.18)' },
};

const WorkflowCard = ({ wf, onEdit, onRun, onDelete }) => {
  const [hov, setHov] = useState(false);
  const tc = TYPE_COLORS[wf.type] || TYPE_COLORS.etl;
  return (
    <div
      onMouseOver={() => setHov(true)} onMouseOut={() => setHov(false)}
      onClick={() => onEdit(wf)}
      style={{
        background: '#fff', border: `1px solid ${hov ? C.border2 : C.border}`,
        borderRadius: 6, overflow: 'hidden', cursor: 'pointer', transition: 'all 0.15s',
        boxShadow: hov ? '0 4px 16px rgba(0,0,0,0.07)' : '0 1px 3px rgba(0,0,0,0.04)',
        display: 'flex', flexDirection: 'column',
      }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '12px 14px', borderBottom: `1px solid ${C.border}`, gap: 8,
      }}>
        <span title={wf.name} style={{
          fontSize: 13, fontWeight: 600, color: C.text, letterSpacing: '-0.02em',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1,
        }}>
          {wf.name || 'Untitled workflow'}
        </span>
        <MoreMenu items={[
          { label: 'Run Workflow', icon: 'play', onClick: () => onRun(wf.id) },
          { label: 'Edit',         icon: 'edit', onClick: () => onEdit(wf) },
          { label: 'Delete',       icon: 'trash', danger: true, onClick: () => onDelete(wf.id) },
        ]} />
      </div>
      <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{
          fontSize: 12, color: C.muted, lineHeight: 1.55,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
          minHeight: 36,
        }}>
          {wf.description || <span style={{ color: C.dim, fontStyle: 'italic' }}>No description</span>}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 10 }}>
          {wf.nodeCount != null && <MetaItem icon="node">{wf.nodeCount} nodes</MetaItem>}
          {wf.createdBy && <MetaItem icon="user">{wf.createdBy}</MetaItem>}
          {wf.createdAt && <MetaItem icon="cal">{wf.createdAt.format('MMM DD')}</MetaItem>}
        </div>
        {/* <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          marginTop: 'auto', paddingTop: 4,
        }}>
          {wf.type ? <Tag {...tc}>{wf.type}</Tag> : <span />}
          <span style={{ fontSize: 11, color: C.dim, fontFamily: MONO }}>
            {wf.lastRun ? `ran ${wf.lastRun.fromNow()}` : 'never run'}
          </span>
        </div> */}
      </div>
    </div>
  );
};

const WorkflowsTab = ({
  onContextChange = () => {},
  pendingOpenWorkflow = null,           // { id, bump } — signal from ChatAssistant via Workflows.js
  onPendingOpenHandled = () => {},      // call after we've handled the signal so it doesn't re-fire
  onFilesDropped = () => {},            // hands a validated data-file drop to the Connections tab
}) => {
  const [workflows, setWorkflows] = useState([]);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState(null);
  const [loading, setLoading] = useState(false);
  const [uploadedDataSource, setUploadedDataSource] = useState(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const workflowCloseHandlerRef = useRef(null);
  const importInputRef = useRef(null);

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

  useEffect(() => {
    fetchWorkflows();
  }, []);

  // When ChatAssistant (via Workflows.js) signals a freshly-built workflow,
  // refresh the list and open that workflow in the editor. Keyed on `bump`
  // so re-building the same id still re-triggers.
  useEffect(() => {
    if (!pendingOpenWorkflow?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const localWorkflows = await workflowsDb.getAll();
        if (cancelled) return;
        const enriched = localWorkflows.map((wf) => ({
          ...wf,
          createdAt: moment(wf.createdAt),
          lastRun: wf.lastExecuted ? moment(wf.lastExecuted) : null,
          updatedAt: moment(wf.updatedAt),
        }));
        setWorkflows(enriched);
        const target = enriched.find((w) => (w.id || w._id) === pendingOpenWorkflow.id);
        if (target) handleEditWorkflow(target);
      } finally {
        if (!cancelled) onPendingOpenHandled();
      }
    })();
    return () => { cancelled = true; };
    // handleEditWorkflow is stable enough for this use; we key purely on bump+id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingOpenWorkflow?.id, pendingOpenWorkflow?.bump]);

  const fetchWorkflows = async () => {
    setLoading(true);
    try {
      // Remote workflow fetch disabled — backend returns 403 for logged-in
      // tokens, so we rely on the local IndexedDB store below instead.
      // const token = localStorage.getItem('auth-token');
      //
      // if (token) {
      //   const response = await axios.get('/workflow/workflows', {
      //     headers: { 'auth-token': token }
      //   });
      //
      //   if (response.data.success) {
      //     const workflowsData = response.data.data.workflows.map(workflow => ({
      //       ...workflow,
      //       createdAt: moment(workflow.createdAt),
      //       lastRun: workflow.lastExecuted ? moment(workflow.lastExecuted) : null,
      //       updatedAt: moment(workflow.updatedAt),
      //     }));
      //     setWorkflows(workflowsData);
      //   }
      // }
      const localWorkflows = await workflowsDb.getAll();
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

  const fetchAllConnections = async () => {
    // Remote connections fetch disabled — backend returns 403 for logged-in
    // tokens, so we use the local IndexedDB store only.
    // const token = localStorage.getItem('auth-token');
    // if (token) {
    //   try {
    //     const response = await axios.post('/workflow/connections', { transformer: false }, {
    //       headers: { 'auth-token': token },
    //     });
    //     if (response.data.success) return response.data.data;
    //   } catch (e) { /* fall through to local */ }
    // }
    return connectionsDb.getAll();
  };

  const resolveDataSourceNodes = (nodes, connections) => {
    return nodes.map(node => {
      if (node.type !== 'dataSource') return node;
      const config = node.data?.config;
      if (!config) return node;

      if (config.sourceConnectionId) {
        const byId = connections.find(c => (c.id || c._id) === config.sourceConnectionId);
        if (byId) return node;
      }

      if (config.sourceConnectionName && config.sourceConnectionType) {
        const byNameType = connections.find(
          c => c.connectionName === config.sourceConnectionName &&
               c.connectionType === config.sourceConnectionType,
        );
        if (byNameType) {
          return {
            ...node,
            data: { ...node.data, config: { ...config, sourceConnectionId: byNameType.id || byNameType._id } },
          };
        }
      }

      if (config.sourceLocalPath) {
        const byPath = connections.find(c => c.fileInfo?.filePath === config.sourceLocalPath);
        if (byPath) {
          return {
            ...node,
            data: {
              ...node.data,
              config: {
                ...config,
                sourceConnectionId: byPath.id || byPath._id,
                sourceConnectionName: byPath.connectionName,
                sourceConnectionType: byPath.connectionType,
              },
            },
          };
        }
      }
      node.unsupported = true;
      return node;
    });
  };

  const handleImportClick = () => importInputRef.current?.click();

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    let parsed;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch {
      message.error('Invalid JSON file');
      return;
    }

    if (!parsed.nodes || !parsed.edges) {
      message.error('File does not appear to be a valid workflow export');
      return;
    }

    let connections = [];
    try { connections = await fetchAllConnections(); } catch { /* proceed without */ }

    const resolvedNodes = resolveDataSourceNodes(parsed.nodes, connections);
    const unresolvedCount = resolvedNodes.filter(n => n.unsupported).length;
    if (unresolvedCount > 0) {
      message.warning(
        `${unresolvedCount} Data Source node${unresolvedCount > 1 ? 's' : ''} could not be matched to an existing connection. You can update them in the editor.`,
      );
    }

    setEditingWorkflow({
      name: parsed.name || '',
      description: parsed.description || '',
      nodes: resolvedNodes,
      edges: parsed.edges,
      executionSteps: parsed.executionSteps || [],
    });
    setIsEditorOpen(true);
  };

  const handleEditWorkflow = (workflow) => {
    setEditingWorkflow(workflow);
    setIsEditorOpen(true);
    onContextChange({
      kind: 'workflow',
      id: workflow.id || workflow._id,
      name: workflow.name,
      summary: workflow.description || `${workflow.nodes?.length || 0} nodes · ${workflow.type || 'workflow'}`,
    });
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
          // Remote delete disabled — backend returns 403 for logged-in tokens,
          // so we always delete from the local IndexedDB store.
          // const token = localStorage.getItem('auth-token');
          // if (token) {
          //   const response = await axios.post('/workflow/workflow-action', {
          //     action: 'delete', workflowId,
          //   }, { headers: { 'auth-token': token } });
          //   if (response.data.success) {
          //     setWorkflows(prev => prev.filter(w => w.id !== workflowId));
          //     message.success('Workflow deleted successfully');
          //   }
          // } else {
          await workflowsDb.delete(workflowId);
          setWorkflows(prev => prev.filter(w => w.id !== workflowId));
          message.success('Workflow deleted locally');
          // }
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
        workflowId, trigger: { type: 'manual' },
      }, { headers: { 'auth-token': localStorage.getItem('auth-token') } });
      if (response.data.success) {
        message.success('Workflow execution started');
        fetchWorkflows();
      }
    } catch (error) {
      if (handleAuthError(error)) return;
      console.error('Error running workflow:', error);
      message.error('Failed to start workflow execution');
    }
  };

  const saveWorkflowData = async (workflowData, workflowId) => {
    const nameConflict = workflows.some(w => {
      if (workflowId && w.id === workflowId) return false;
      return w.name?.trim().toLowerCase() === workflowData.name?.trim().toLowerCase();
    });
    if (nameConflict) {
      message.error(`A workflow named "${workflowData.name}" already exists. Please choose a unique name.`);
      throw new Error('Duplicate workflow name');
    }

    // Remote save/update disabled — backend returns 403 for logged-in tokens,
    // so we always persist to the local IndexedDB store.
    // const token = localStorage.getItem('auth-token');
    // if (token) {
    //   if (workflowId) {
    //     const response = await axios.post('/workflow/workflow-action', {
    //       action: 'update', workflowId, ...workflowData,
    //     }, { headers: { 'auth-token': token } });
    //     if (!response.data.success) throw new Error(response.data.error || 'Failed to update workflow');
    //     return workflowId;
    //   } else {
    //     const newWorkflowData = {
    //       ...workflowData,
    //       ...(uploadedDataSource && { connectionId: uploadedDataSource.connectionId }),
    //     };
    //     const response = await axios.post('/workflow/workflow-save', newWorkflowData, {
    //       headers: { 'auth-token': token },
    //     });
    //     if (!response.data.success) throw new Error(response.data.error || 'Failed to create workflow');
    //     return response.data.data?.id || null;
    //   }
    // } else {
    console.log("workflowId, workflowData: ", workflowId, workflowData)
    if (workflowId) {
      await workflowsDb.update(workflowId, workflowData);
      return workflowId;
    } else {
      const newWorkflow = {
        ...workflowData,
        ...(uploadedDataSource && { connectionId: uploadedDataSource.connectionId }),
      };
      const saved = await workflowsDb.save(newWorkflow);
      return saved.id;
    }
    // }
  };

  const handleSaveWorkflow = async (workflowData) => {
    try {
      const workflowId = editingWorkflow?.id || null;
      console.log('workflowId: ', workflowId, workflowData)
      await saveWorkflowData(workflowData, workflowId);
      message.success(workflowId ? 'Workflow updated successfully' : 'Workflow created successfully');
      await fetchWorkflows();
      setIsEditorOpen(false);
      setEditingWorkflow(null);
      setUploadedDataSource(null);
      onContextChange(null);
    } catch (error) {
      if (error.message === 'Duplicate workflow name') throw error;
      if (handleAuthError(error)) return;
      console.error('Error saving workflow:', error);
      message.error('Failed to save workflow');
      throw error;
    }
  };

  const handleAutoSave = async (workflowData, workflowId) => {
    try {
      const savedId = await saveWorkflowData(workflowData, workflowId);
      await fetchWorkflows();
      return savedId;
    } catch (error) {
      if (handleAuthError(error)) return null;
      throw error;
    }
  };

  const handleModalClose = () => {
    if (workflowCloseHandlerRef.current) {
      workflowCloseHandlerRef.current();
    } else {
      handleWorkflowClose();
    }
  };

  const handleWorkflowClose = () => {
    setIsEditorOpen(false);
    setEditingWorkflow(null);
    setUploadedDataSource(null);
    workflowCloseHandlerRef.current = null;
    // Nothing is open any more — drop the chat assistant's focus chip.
    onContextChange(null);
  };

  const registerWorkflowCloseHandler = (handler) => {
    workflowCloseHandlerRef.current = handler;
  };

  // A data file dropped here isn't a workflow, so there is nothing to do with
  // it on this tab. Validate it with the same rules the Connections tab uses,
  // then hand the batch over and let the app switch there, where the import
  // popups open. The editor renders in a portal, so its own canvas drops never
  // reach this handler.
  // The editor renders inside this tab's modal and handles its own canvas
  // drops, so this target stands down entirely while it is open.
  const { onDragOver, onDragLeave } = useMemo(
    () => fileDragHandlers(setIsDragOver, isEditorOpen), [isEditorOpen]);

  const onDrop = (event) => {
    if (isEditorOpen) return;
    event.preventDefault();
    setIsDragOver(false);
    const validFiles = collectDroppableFiles(event);
    if (validFiles.length > 0) onFilesDropped(validFiles);
  };

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden', background: C.surface, position: 'relative' }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isDragOver && <FileDropOverlay title="Drop a file to create a data source" />}

      <PageHeader
        title="Workflows"
        sub="Create and manage your data processing workflows"
        actions={[
          <Btn key="imp" icon="import" onClick={handleImportClick}>Import</Btn>,
          <input key="imp-input" ref={importInputRef} type="file"
            accept=".json,application/json" style={{ display: 'none' }}
            onChange={handleImportFile} />,
          <Btn key="new" variant="primary" icon="plus" onClick={handleCreateWorkflow}>Create Workflow</Btn>,
        ]}
      />

      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: 50 }}>
            <Spin size="large" />
            <div style={{ marginTop: 16, color: C.muted, fontSize: 12 }}>Loading workflows…</div>
          </div>
        ) : workflows.length === 0 ? (
          <div style={{
            textAlign: 'center', padding: '60px 24px', background: '#fff',
            border: `1px dashed ${C.border2}`, borderRadius: 6, color: C.muted,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 6 }}>
              No workflows created yet
            </div>
            <div style={{ fontSize: 12, color: C.muted }}>
              Create a connection and create your first workflow to start processing data
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {workflows.map(wf => (
              <WorkflowCard key={wf.id || wf._id}
                wf={wf}
                onEdit={handleEditWorkflow}
                onRun={handleRunWorkflow}
                onDelete={handleDeleteWorkflow}
              />
            ))}
          </div>
        )}
      </div>

      <Modal
        open={isEditorOpen}
        onCancel={handleModalClose}
        footer={null}
        {...fullscreenModalProps({ bodyPadding: 0 })}
        // The editor draws its own ✕ in its header, next to Execute / Save,
        // where it has room to breathe — antd's floating one would land on
        // top of those buttons.
        closable={false}
        destroyOnClose
        maskClosable={false}
      >
        <WorkflowEditor
          workflow={editingWorkflow}
          dataSource={uploadedDataSource}
          onSave={handleSaveWorkflow}
          onAutoSave={handleAutoSave}
          onCancel={handleWorkflowClose}
          onCloseRequest={registerWorkflowCloseHandler}
        />
      </Modal>
    </div>
  );
};

export default WorkflowsTab;
