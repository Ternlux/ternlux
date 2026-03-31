import React, { useState, useMemo } from 'react';
import {
    Box,
    Paper,
    Typography,
    Avatar,
    Fade,
    IconButton,
    Collapse
} from '@mui/material';
import {
    SmartToy as BotIcon,
    Code as CodeIcon
} from '@mui/icons-material';
import Editor from '@monaco-editor/react';
import DataVisualization from './DataVisualization';
import MultiStepProgress from './MultiStepProgress';
import StepResultHeader from './StepResultHeader';

// Helper function to parse markdown bold syntax and newlines into React elements
const parseMarkdownBold = (text) => {
    if (!text) return text;

    const lines = text.split('\n');

    const processLine = (line, lineIndex) => {
        const parts = [];
        let lastIndex = 0;
        const boldRegex = /\*\*(.*?)\*\*/g;
        let match;

        while ((match = boldRegex.exec(line)) !== null) {
            if (match.index > lastIndex) {
                parts.push(line.substring(lastIndex, match.index));
            }
            parts.push(
                <strong key={`${lineIndex}-${match.index}`} style={{ fontWeight: 700 }}>
                    {match[1]}
                </strong>
            );
            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < line.length) {
            parts.push(line.substring(lastIndex));
        }

        return parts.length > 0 ? parts : line;
    };

    const result = [];
    lines.forEach((line, index) => {
        if (index > 0) {
            result.push(<br key={`br-${index}`} />);
        }
        // Empty lines (from \n\n) already contributed a <br> above — skip rendering content
        if (line.trim() === '') return;
        result.push(...(Array.isArray(processLine(line, index)) ? processLine(line, index) : [processLine(line, index)]));
    });

    return result.length > 0 ? result : text;
};

// Helper function to get segmentation image link
const getImageLink = (age, income) => {
    let incomeValue = 1;
    if (age !== 'under_18') {
        const incomeMapping = {
            'low_income': 1,
            'lower_middle_income': 2,
            'middle_income': 3,
            'upper_middle_income': 4,
            'high_income': 5,
            'very_high_income': 6
        };
        incomeValue = incomeMapping[income] || 1;
    }
    return `/segmentation/${age}_${incomeValue}.jpeg`;
};

// Code Editor Component
const CodeEditor = ({ code, language = 'sql', height = 300 }) => {
    return (
        <Box
            sx={{
                border: '1px solid #333',
                borderRadius: 1,
                overflow: 'hidden'
            }}
        >
            <Editor
                height={height}
                defaultLanguage={language}
                value={code}
                theme="vs-dark"
                options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    fontSize: 13,
                    lineNumbers: 'off',
                    renderLineHighlight: 'none',
                    scrollbar: {
                        vertical: 'auto',
                        horizontal: 'auto',
                        verticalScrollbarSize: 10,
                        horizontalScrollbarSize: 10
                    },
                    padding: { top: 10, bottom: 10 }
                }}
            />
        </Box>
    );
};

const ChatMessage = ({
    message,
    index,
    messages,
    isFullscreen,
    multiStepData,
    formatTimestamp,
    onSaveToMain
}) => {
    // console.log('message: ', message)
    const isUser = message.sender === 'user';
    const showAvatar = !isUser && (index === 0 || messages[index - 1]?.sender !== 'bot');
    const [showSql, setShowSql] = useState(false);
    const [showDdl, setShowDdl] = useState(false);
    const [shownosqlOperation, setShownosqlOperation] = useState(false);
    const [showTransformFunction, setShowTransformFunction] = useState(false);
    const [showSourcesConfig, setShowSourcesConfig] = useState(false);
    const [showTargetDdl, setShowTargetDdl] = useState(false);
    const [showJoinSql, setShowJoinSql] = useState(false);
    const [showJoinColumns, setShowJoinColumns] = useState(false);
    const [showSelectedColumns, setShowSelectedColumns] = useState(false);
    const [showJavascriptFunction, setShowJavascriptFunction] = useState(false);

    const toggleSqlView = () => {
        setShowSql(prev => !prev);
    };

    const toggleDdlView = () => {
        setShowDdl(prev => !prev);
    };

    const togglenosqlOperationView = () => {
        setShownosqlOperation(prev => !prev);
    };

    const toggleTransformFunctionView = () => {
        setShowTransformFunction(prev => !prev);
    };

    const toggleSourcesConfigView = () => {
        setShowSourcesConfig(prev => !prev);
    };

    const toggleTargetDdlView = () => {
        setShowTargetDdl(prev => !prev);
    };

    const toggleJoinSqlView = () => {
        setShowJoinSql(prev => !prev);
    };

    const toggleJoinColumnsView = () => {
        setShowJoinColumns(prev => !prev);
    };

    const toggleSelectedColumnsView = () => {
        setShowSelectedColumns(prev => !prev);
    };

    const toggleJavascriptFunctionView = () => {
        setShowJavascriptFunction(prev => !prev);
    };
    
    const nosqlOperation = useMemo(() => {
        if(!message?.metadata?.nosqlOperation) return;
        // console.log('message?.metadata?.nosqlOperation: ', message?.metadata?.nosqlOperation, typeof message.metadata.nosqlOperation)
        let jsonValue = message.metadata.nosqlOperation.trim()
        try{
            if(typeof message.metadata.nosqlOperation === 'string')
            jsonValue = JSON.parse(message.metadata.nosqlOperation)
        }catch(e){
            console.log('failed to turn into json')
            return jsonValue
        }
        return  JSON.stringify(message.metadata.nosqlOperation, null, 2)                             
    }, [message?.metadata?.nosqlOperation])
    return (
        <Fade in={true} key={message.id} timeout={300}>
            <Box
                sx={{
                    display: 'flex',
                    mb: 2,
                    justifyContent: isUser ? 'flex-end' : 'flex-start',
                    px: isFullscreen ? 3 : 2
                }}
            >
                {/* Bot avatar */}
                {!isUser && showAvatar && (
                    <Avatar 
                        sx={{ 
                            width: 32, 
                            height: 32, 
                            mr: 2,
                            bgcolor: 'primary.main',
                            alignSelf: 'flex-end'
                        }}
                    >
                        <BotIcon fontSize="small" />
                    </Avatar>
                )}
                
                {/* Spacer for non-avatar messages */}
                {!isUser && !showAvatar && <Box sx={{ width: 48 }} />}
                
                {/* Message content */}
                <Box
                    sx={{
                        maxWidth: isFullscreen ? '70%' : '85%',
                        minWidth: 120,
                        position: 'relative'
                    }}
                >
                    {/* Message bubble */}
                    <Paper
                        elevation={0}
                        sx={{
                            p: 2,
                            bgcolor: isUser ? 'primary.main' : 'grey.100',
                            color: isUser ? 'primary.contrastText' : 'text.primary',
                            borderRadius: 4,
                            borderTopLeftRadius: !isUser && showAvatar ? 1 : 4,
                            borderTopRightRadius: isUser ? 1 : 4,
                            borderBottomLeftRadius: 4,
                            borderBottomRightRadius: 4,
                            position: 'relative',
                            wordBreak: 'break-word'
                        }}
                    >
                        {/* Multi-step step result header */}
                        {message.metadata?.type === 'step_result' && (
                            <StepResultHeader metadata={message.metadata} />
                        )}
                        
                        {/* Multi-step Progress Display */}
                        {(message.metadata?.type === 'multi_step_plan' && message.metadata?.plan) ? (
                            <Box sx={{ mt: 2 }}>
                                <MultiStepProgress 
                                    data={{
                                        goal: message.metadata.plan.goal,
                                        steps: message.metadata.plan.steps,
                                        stepResults: multiStepData?.stepResults,
                                        status: multiStepData?.status
                                    }} 
                                />
                            </Box>
                        ) : (
                            <Box sx={{ display: 'flex', gap: 2 }}>
                                {/* Segmentation Image */}
                                {message.metadata?.segmentation && message.metadata.segmentation.age && message.metadata.segmentation.income && (
                                    <Box sx={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 1,
                                        minWidth: 100,
                                        maxWidth: 100
                                    }}>
                                        <Box
                                            component="img"
                                            src={getImageLink(message.metadata.segmentation.age, message.metadata.segmentation.income)}
                                            alt={`${message.metadata.segmentation.age} ${message.metadata.segmentation.income}`}
                                            sx={{
                                                width: '100%',
                                                height: 'auto',
                                                borderRadius: 1,
                                                border: '1px solid #e0e0e0'
                                            }}
                                            onError={(e) => {
                                                e.target.style.display = 'none';
                                            }}
                                        />
                                    </Box>
                                )}

                                {/* Message text */}
                                <Box sx={{ flex: 1 }}>
                                    <Typography
                                        variant="body1"
                                        sx={{
                                            fontSize: '0.95rem',
                                            lineHeight: 1.4,
                                            whiteSpace: 'pre-wrap',
                                            wordWrap: 'break-word',
                                            color: isUser ? 'white' : 'inherit'
                                        }}
                                    >
                                        {parseMarkdownBold(message.text)}
                                    </Typography>
                                </Box>
                            </Box>
                        )}

                        {/* DDL Code Display */}
                        {message.metadata?.ddl && !isUser && (
                            <Box sx={{ mt: 2 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                    <IconButton
                                        size="small"
                                        onClick={toggleDdlView}
                                        sx={{
                                            color: 'success.main',
                                            bgcolor: 'rgba(46, 125, 50, 0.08)',
                                            '&:hover': {
                                                bgcolor: 'rgba(46, 125, 50, 0.12)'
                                            }
                                        }}
                                    >
                                        <CodeIcon fontSize="small" />
                                    </IconButton>
                                    <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                                        {showDdl ? 'Hide DDL (CREATE TABLE)' : 'View DDL (CREATE TABLE)'}
                                    </Typography>
                                </Box>
                                <Collapse in={showDdl}>
                                    <CodeEditor
                                        code={message.metadata.ddl}
                                        language="sql"
                                        height={Math.min(300, (message.metadata.ddl.split('\n').length + 1) * 19 + 20)}
                                    />
                                </Collapse>
                            </Box>
                        )}

                        {/* SQL Code Display */}
                        {message.metadata?.sql && !isUser && (
                            <Box sx={{ mt: 2 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                    <IconButton
                                        size="small"
                                        onClick={toggleSqlView}
                                        sx={{
                                            color: 'primary.main',
                                            bgcolor: 'rgba(25, 118, 210, 0.08)',
                                            '&:hover': {
                                                bgcolor: 'rgba(25, 118, 210, 0.12)'
                                            }
                                        }}
                                    >
                                        <CodeIcon fontSize="small" />
                                    </IconButton>
                                    <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                                        {showSql ? 'Hide SQL (INSERT)' : 'View SQL (INSERT)'}
                                    </Typography>
                                </Box>
                                <Collapse in={showSql}>
                                    <CodeEditor
                                        code={message.metadata.sql}
                                        language="sql"
                                        height={Math.min(300, (message.metadata.sql.split('\n').length + 1) * 19 + 20)}
                                    />
                                </Collapse>
                            </Box>
                        )}

                        {/* MongoDB Operation Display */}
                        {message.metadata?.operationType && message.metadata?.nosqlOperation && !isUser && (
                            <Box sx={{ mt: 2 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                    <IconButton
                                        size="small"
                                        onClick={togglenosqlOperationView}
                                        sx={{
                                            color: 'success.main',
                                            bgcolor: 'rgba(46, 125, 50, 0.08)',
                                            '&:hover': {
                                                bgcolor: 'rgba(46, 125, 50, 0.12)'
                                            }
                                        }}
                                    >
                                        <CodeIcon fontSize="small" />
                                    </IconButton>
                                    <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                                        {shownosqlOperation ? `Hide Operation ${message.metadata.operationType === 'javascript'?  'Filter' : message.metadata.operationType}` : `View Operation ${message.metadata.operationType === 'javascript'?  'Filter' : message.metadata.operationType}`}
                                    </Typography>
                                </Box>
                                <Collapse in={shownosqlOperation}>
                                    <CodeEditor
                                        code={nosqlOperation}
                                        language="json"
                                        height={Math.min(300, (nosqlOperation?.split('\n').length + 1) * 19 + 20)}
                                    />
                                </Collapse>
                            </Box>
                        )}

                        {/* Transform Function Display */}
                        {message.metadata?.transformFunction && !isUser && (
                            <Box sx={{ mt: 2 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                    <IconButton
                                        size="small"
                                        onClick={toggleTransformFunctionView}
                                        sx={{
                                            color: 'warning.main',
                                            bgcolor: 'rgba(237, 108, 2, 0.08)',
                                            '&:hover': {
                                                bgcolor: 'rgba(237, 108, 2, 0.12)'
                                            }
                                        }}
                                    >
                                        <CodeIcon fontSize="small" />
                                    </IconButton>
                                    <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                                        {showTransformFunction ? 'Hide Transform Function' : 'View Transform Function'}
                                    </Typography>
                                </Box>
                                <Collapse in={showTransformFunction}>
                                    <CodeEditor
                                        code={message.metadata.transformFunction}
                                        language="javascript"
                                        height={Math.min(400, (message.metadata.transformFunction.split('\n').length + 1) * 19 + 20)}
                                    />
                                </Collapse>
                            </Box>
                        )}

                        {/* Sources Config Display */}
                        {message.metadata?.sourcesConfig && !isUser && (
                            <Box sx={{ mt: 2 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                    <IconButton
                                        size="small"
                                        onClick={toggleSourcesConfigView}
                                        sx={{
                                            color: 'info.main',
                                            bgcolor: 'rgba(2, 136, 209, 0.08)',
                                            '&:hover': {
                                                bgcolor: 'rgba(2, 136, 209, 0.12)'
                                            }
                                        }}
                                    >
                                        <CodeIcon fontSize="small" />
                                    </IconButton>
                                    <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                                        {showSourcesConfig ? 'Hide Sources Configuration' : 'View Sources Configuration'}
                                    </Typography>
                                </Box>
                                <Collapse in={showSourcesConfig}>
                                    <CodeEditor
                                        code={JSON.stringify(message.metadata.sourcesConfig, null, 2)}
                                        language="json"
                                        height={Math.min(400, (JSON.stringify(message.metadata.sourcesConfig, null, 2).split('\n').length + 1) * 19 + 20)}
                                    />
                                </Collapse>
                            </Box>
                        )}

                        {/* Target DDL Display */}
                        {message.metadata?.targetDdl && !isUser && (
                            <Box sx={{ mt: 2 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                    <IconButton
                                        size="small"
                                        onClick={toggleTargetDdlView}
                                        sx={{
                                            color: 'success.main',
                                            bgcolor: 'rgba(46, 125, 50, 0.08)',
                                            '&:hover': {
                                                bgcolor: 'rgba(46, 125, 50, 0.12)'
                                            }
                                        }}
                                    >
                                        <CodeIcon fontSize="small" />
                                    </IconButton>
                                    <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                                        {showTargetDdl ? 'Hide Target DDL' : 'View Target DDL'}
                                    </Typography>
                                </Box>
                                <Collapse in={showTargetDdl}>
                                    <CodeEditor
                                        code={message.metadata.targetDdl}
                                        language="sql"
                                        height={Math.min(300, (message.metadata.targetDdl.split('\n').length + 1) * 19 + 20)}
                                    />
                                </Collapse>
                            </Box>
                        )}

                        {/* Join SQL Display */}
                        {message.metadata?.joinSql && !isUser && (
                            <Box sx={{ mt: 2 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                    <IconButton
                                        size="small"
                                        onClick={toggleJoinSqlView}
                                        sx={{
                                            color: 'primary.main',
                                            bgcolor: 'rgba(25, 118, 210, 0.08)',
                                            '&:hover': {
                                                bgcolor: 'rgba(25, 118, 210, 0.12)'
                                            }
                                        }}
                                    >
                                        <CodeIcon fontSize="small" />
                                    </IconButton>
                                    <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                                        {showJoinSql ? 'Hide Join SQL' : 'View Join SQL'}
                                    </Typography>
                                </Box>
                                <Collapse in={showJoinSql}>
                                    <CodeEditor
                                        code={message.metadata.joinSql}
                                        language="sql"
                                        height={Math.min(400, (message.metadata.joinSql.split('\n').length + 1) * 19 + 20)}
                                    />
                                </Collapse>
                            </Box>
                        )}

                        {/* Join Columns Display */}
                        {message.metadata?.joinColumns && !isUser && (
                            <Box sx={{ mt: 2 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                    <IconButton
                                        size="small"
                                        onClick={toggleJoinColumnsView}
                                        sx={{
                                            color: 'secondary.main',
                                            bgcolor: 'rgba(156, 39, 176, 0.08)',
                                            '&:hover': {
                                                bgcolor: 'rgba(156, 39, 176, 0.12)'
                                            }
                                        }}
                                    >
                                        <CodeIcon fontSize="small" />
                                    </IconButton>
                                    <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                                        {showJoinColumns ? 'Hide Join Columns' : 'View Join Columns'}
                                    </Typography>
                                </Box>
                                <Collapse in={showJoinColumns}>
                                    <CodeEditor
                                        code={JSON.stringify(message.metadata.joinColumns, null, 2)}
                                        language="json"
                                        height={Math.min(300, (JSON.stringify(message.metadata.joinColumns, null, 2).split('\n').length + 1) * 19 + 20)}
                                    />
                                </Collapse>
                            </Box>
                        )}

                        {/* Selected Columns Display */}
                        {message.metadata?.selectedColumns && !isUser && (
                            <Box sx={{ mt: 2 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                    <IconButton
                                        size="small"
                                        onClick={toggleSelectedColumnsView}
                                        sx={{
                                            color: 'warning.main',
                                            bgcolor: 'rgba(237, 108, 2, 0.08)',
                                            '&:hover': {
                                                bgcolor: 'rgba(237, 108, 2, 0.12)'
                                            }
                                        }}
                                    >
                                        <CodeIcon fontSize="small" />
                                    </IconButton>
                                    <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                                        {showSelectedColumns ? 'Hide Selected Columns' : 'View Selected Columns'}
                                    </Typography>
                                </Box>
                                <Collapse in={showSelectedColumns}>
                                    <CodeEditor
                                        code={JSON.stringify(message.metadata.selectedColumns, null, 2)}
                                        language="json"
                                        height={Math.min(300, (JSON.stringify(message.metadata.selectedColumns, null, 2).split('\n').length + 1) * 19 + 20)}
                                    />
                                </Collapse>
                            </Box>
                        )}

                        {/* JavaScript Join Function Display */}
                        {message.metadata?.javascriptFunction && !isUser && (
                            <Box sx={{ mt: 2 }}>
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                    <IconButton
                                        size="small"
                                        onClick={toggleJavascriptFunctionView}
                                        sx={{
                                            color: 'error.main',
                                            bgcolor: 'rgba(211, 47, 47, 0.08)',
                                            '&:hover': {
                                                bgcolor: 'rgba(211, 47, 47, 0.12)'
                                            }
                                        }}
                                    >
                                        <CodeIcon fontSize="small" />
                                    </IconButton>
                                    <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                                        {showJavascriptFunction ? 'Hide JavaScript Join Function' : 'View JavaScript Join Function'}
                                    </Typography>
                                </Box>
                                <Collapse in={showJavascriptFunction}>
                                    <CodeEditor
                                        code={message.metadata.javascriptFunction}
                                        language="javascript"
                                        height={Math.min(400, (message.metadata.javascriptFunction.split('\n').length + 1) * 19 + 20)}
                                    />
                                </Collapse>
                            </Box>
                        )}

                        {/* Visualization */}
                        {message.visualizationData && (
                            <Box sx={{ mt: 2, borderRadius: 2, overflow: 'hidden' }}>
                                <DataVisualization
                                    visualizationData={message.visualizationData}
                                    onSaveToMain={onSaveToMain}
                                />
                            </Box>
                        )}
                        
                        {/* Timestamp */}
                        <Typography 
                            variant="caption" 
                            sx={{ 
                                display: 'block', 
                                mt: 1, 
                                opacity: 0.7,
                                fontSize: '0.75rem'
                            }}
                        >
                            {formatTimestamp(message.timestamp)}
                        </Typography>
                    </Paper>
                </Box>
                
                {/* User avatar space (invisible) */}
                {isUser && <Box sx={{ width: 48 }} />}
            </Box>
            
        </Fade>
    );
};

export default ChatMessage;