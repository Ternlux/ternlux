import React, { useState } from 'react';
import {
    Box,
    Typography,
    IconButton,
    Button,
    TextField,
    InputAdornment,
    Chip,
    alpha,
    useTheme
} from '@mui/material';
import {
    Chat as ChatIcon,
    Send as SendIcon,
    Close as CloseIcon,
    Fullscreen as FullscreenIcon,
    FullscreenExit as FullscreenExitIcon,
    History as HistoryIcon,
    TrendingUp as TrendingUpIcon,
    SmartToy as BotIcon,
    Assignment as ReportIcon,
    PlayArrow as PlayArrowIcon
} from '@mui/icons-material';
import { Select } from 'antd';
import ChatMessage from './ChatMessage';
import TypingIndicator from './TypingIndicator';
import MultiStepReport from './MultiStepReport';

const { Option } = Select;

const ChatArea = ({
    isFullscreen,
    currentChatTitle,
    multiStepData,
    handleFullscreen,
    handleToggleChat,
    chatContainerRef,
    messages,
    isLoading,
    progressInfo,
    messagesEndRef,
    inputRef,
    inputValue,
    setInputValue,
    handleKeyPress,
    handleSendMessage,
    formatTimestamp,
    onSaveToMain,
    // ── node-chat extensions ──
    choices = [],          // array of { label, value, description?, variant?, fullWidth? }
    onChoiceSelect = () => {},
    hideHeader = false,
    inputPlaceholder = 'Message...',
    disableInput = false,
    // ── workflow execution ──
    showRunButton = false,
    onRun = null,
    runButtonLoading = false,
}) => {
    const theme = useTheme();
    const [isReportOpen, setIsReportOpen] = useState(false);

    // Check if there's completed multi-step data to show report button
    const hasCompletedMultiStep = multiStepData?.completedSteps && multiStepData?.completedSteps === multiStepData?.totalSteps;
    // console.log('hasCompletedMultiStep: ', hasCompletedMultiStep, multiStepData)

    // Handle opening report with URL update
    const handleOpenReport = () => {
        setIsReportOpen(true);

        // Add reportId to URL if available
        if (multiStepData?.reportId) {
            const url = new URL(window.location);
            url.searchParams.set('reportid', multiStepData.reportId);
            window.history.replaceState({}, '', url);
        }
    };

    // Handle closing report with URL cleanup
    const handleCloseReport = () => {
        setIsReportOpen(false);

        // Remove reportId from URL
        const url = new URL(window.location);
        url.searchParams.delete('reportid');
        window.history.replaceState({}, '', url);
    };

    return (
        <Box sx={{ 
            flex: 1, 
            display: 'flex', 
            flexDirection: 'column',
            height: '100%',
            overflow: 'hidden'
        }}>
            {/* Chat header */}
            {!hideHeader && <Box
                sx={{
                    p: 2,
                    borderBottom: 1,
                    borderColor: 'divider',
                    bgcolor: 'grey.50',
                    color: 'rgba(0, 0, 0, 0.87)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between'
                }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', width: isFullscreen ? '90%' : 'auto'}}>
                    {!isFullscreen && (
                        <ChatIcon sx={{ mr: 1, color: 'rgba(0, 0, 0, 0.87)' }} />
                    )}
                    <Typography
                        variant={isFullscreen ? "h6" : "body1"}
                        sx={{ fontWeight: 600, color: 'rgba(0, 0, 0, 0.87)', pr:2, width: isFullscreen ? 'auto' : 120 }}
                    >
                        {/* {isFullscreen ? currentChatTitle : 'Business Assistant'} */}
                        {currentChatTitle}
                    </Typography>
                    {showRunButton && onRun && (
                        <Button
                            size="small"
                            startIcon={<PlayArrowIcon />}
                            onClick={onRun}
                            disabled={runButtonLoading}
                            sx={{
                                mr: 1,
                                color: 'white',
                                bgcolor: '#52c41a',
                                '&:hover': {
                                    bgcolor: '#389e0d',
                                    transform: 'scale(1.05)'
                                },
                                '&:disabled': {
                                    bgcolor: '#d9d9d9',
                                    color: 'rgba(0, 0, 0, 0.25)'
                                },
                                transition: 'all 0.2s ease-in-out',
                                fontWeight: 600,
                                borderRadius: 2,
                                px: 2
                            }}
                        >
                            {runButtonLoading ? 'Running...' : 'Run Step'}
                        </Button>
                    )}
                    {hasCompletedMultiStep && (
                        <Button
                            size="small"
                            startIcon={<ReportIcon />}
                            onClick={handleOpenReport}
                            sx={{
                                mr: 1,
                                color: 'white',
                                bgcolor: '#1570EF',
                                '&:hover': {
                                    bgcolor: '#1d4ed8',
                                    transform: 'scale(1.05)'
                                },
                                transition: 'all 0.2s ease-in-out',
                                fontWeight: 600,
                                borderRadius: 2,
                                px: 2
                            }}
                        >
                            Report
                        </Button>
                    )}
                    {multiStepData && !hasCompletedMultiStep && (
                        <Chip
                            label={`${multiStepData.completedSteps || 0}/${multiStepData.totalSteps || 0} steps`}
                            size="small"
                            color="secondary"
                            sx={{ ml: 2 }}
                            icon={<TrendingUpIcon />}
                        />
                    )}
                </Box>
                
                <Box>
                    {!isFullscreen && (
                        <Button
                            size="small"
                            startIcon={<HistoryIcon />}
                            onClick={handleFullscreen}
                            sx={{ 
                                mr: 1,
                                color: 'white',
                                bgcolor: 'rgb(79, 56, 240)',
                                '&:hover': { 
                                    bgcolor: '#1d4ed8',
                                    transform: 'scale(1.05)'
                                },
                                transition: 'all 0.2s ease-in-out',
                                fontWeight: 600,
                                borderRadius: 2,
                                px: 2
                            }}
                        >
                            History
                        </Button>
                    )}

                    <IconButton 
                        size="small" 
                        onClick={handleFullscreen} 
                        sx={{ 
                            color: 'inherit',
                            p: 0.5,
                            alignSelf: 'center'
                        }}
                    >
                        {isFullscreen ? <FullscreenExitIcon fontSize="small" /> : <FullscreenIcon fontSize="small" />}
                    </IconButton>
                    <IconButton 
                        size="small" 
                        onClick={handleToggleChat} 
                        sx={{ 
                            color: 'inherit',
                            p: 0.5,
                            alignSelf: 'center'
                        }}
                    >
                        <CloseIcon fontSize="small" />
                    </IconButton>
                </Box>
            </Box>}

            {/* Messages area */}
            <Box
                ref={chatContainerRef}
                sx={{
                    flex: 1,
                    overflow: 'auto',
                    bgcolor: 'background.default',
                    py: 2
                }}
            >
                {messages.length === 0 ? (
                    <Box sx={{ 
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'center', 
                        height: '100%',
                        flexDirection: 'column',
                        gap: 2,
                        color: 'text.secondary'
                    }}>
                        <BotIcon sx={{ fontSize: 64, opacity: 0.3 }} />
                        <Typography variant="h6" color="text.secondary">
                            How can I help you today?
                        </Typography>
                    </Box>
                ) : (
                    <>
                        {messages.map((message, index) => (
                            <ChatMessage
                                key={message.id}
                                message={message}
                                index={index}
                                messages={messages}
                                isFullscreen={isFullscreen}
                                multiStepData={multiStepData}
                                formatTimestamp={formatTimestamp}
                                onSaveToMain={onSaveToMain}
                            />
                        ))}
                        {isLoading && (
                            <TypingIndicator
                                isLoading={isLoading}
                                progressInfo={progressInfo}
                                isFullscreen={isFullscreen}
                            />
                        )}

                        {/* Bot-side choice buttons or dropdown */}
                        {!isLoading && choices.length > 0 && (
                            <Box
                                sx={{
                                    display: 'flex',
                                    justifyContent: 'flex-start',
                                    px: isFullscreen ? 3 : 2,
                                    mb: 2,
                                    pl: isFullscreen ? 9 : 8,  // align with bot message text
                                }}
                            >
                                {choices[0]?.displayType === 'dropdown' ? (
                                    // Render dropdown
                                    <Box sx={{ maxWidth: isFullscreen ? '70%' : '85%', width: '100%' }}>
                                        <Select
                                            showSearch
                                            placeholder="Search and select a table..."
                                            style={{ width: '100%' }}
                                            size="large"
                                            filterOption={(input, option) =>
                                                option.children.toLowerCase().indexOf(input.toLowerCase()) >= 0
                                            }
                                            onChange={(value) => {
                                                const selectedChoice = choices.find(c => c.value === value);
                                                if (selectedChoice) {
                                                    onChoiceSelect(selectedChoice);
                                                }
                                            }}
                                        >
                                            {choices.map((choice) => (
                                                <Option key={String(choice.value)} value={choice.value}>
                                                    {choice.label}
                                                </Option>
                                            ))}
                                        </Select>
                                    </Box>
                                ) : (
                                    // Render buttons (original behavior)
                                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, maxWidth: isFullscreen ? '70%' : '85%' }}>
                                        {choices.map((choice) => (
                                            <Button
                                                key={String(choice.value ?? choice.label)}
                                                variant={choice.variant || 'outlined'}
                                                size="small"
                                                onClick={() => onChoiceSelect(choice)}
                                                sx={{
                                                    borderRadius: 2,
                                                    textTransform: 'none',
                                                    textAlign: 'left',
                                                    justifyContent: 'flex-start',
                                                    fontWeight: choice.variant === 'contained' ? 600 : 400,
                                                    ...(choice.fullWidth ? { width: '100%' } : {}),
                                                    py: choice.description ? 1 : 0.5,
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: 1,
                                                }}
                                            >
                                                {choice.icon && (
                                                    <Box sx={{
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        flexShrink: 0,
                                                        '& svg': {
                                                            fill: choice.variant === 'contained' ? '#fff' : '#1976d2',
                                                            color: choice.variant === 'contained' ? '#fff' : 'primary.main',
                                                        }
                                                    }}>
                                                        {choice.icon}
                                                    </Box>
                                                )}
                                                <Box sx={{ flex: 1 }}>
                                                    <Typography variant="body2" sx={{ fontWeight: 'inherit', lineHeight: 1.3 }}>
                                                        {choice.label}
                                                    </Typography>
                                                    {choice.description && (
                                                        <Typography variant="caption" sx={{ display: 'block', opacity: 0.75 }}>
                                                            {choice.description}
                                                        </Typography>
                                                    )}
                                                </Box>
                                            </Button>
                                        ))}
                                    </Box>
                                )}
                            </Box>
                        )}

                        <div ref={messagesEndRef} />
                    </>
                )}
            </Box>

            {/* Input area */}
            <Box
                sx={{
                    p: isFullscreen ? 3 : 2,
                    borderTop: 1,
                    borderColor: 'divider',
                    bgcolor: 'background.paper'
                }}
            >
                <Box sx={{ 
                    maxWidth: isFullscreen ? 800 : '100%', 
                    mx: 'auto',
                    display: 'flex',
                    gap: 1,
                    alignItems: 'flex-end'
                }}>
                    <TextField
                        ref={inputRef}
                        fullWidth
                        multiline
                        minRows={2}
                        maxRows={10}
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        onKeyPress={handleKeyPress}
                        placeholder={choices.length > 0 ? 'Select an option above…' : inputPlaceholder}
                        disabled={isLoading || disableInput}
                        variant="outlined"
                        sx={{
                            '& .MuiOutlinedInput-root': {
                                borderRadius: 3,
                                bgcolor: 'background.paper',
                                '& fieldset': {
                                    borderColor: alpha(theme.palette.grey[400], 0.5)
                                },
                                '&:hover fieldset': {
                                    borderColor: 'grey.400'
                                },
                                '&.Mui-focused fieldset': {
                                    borderColor: 'primary.main'
                                },
                                '& textarea': {
                                    resize: 'none'
                                }
                            },
                        }}
                        InputProps={{
                            endAdornment: inputValue.trim() && (
                                <InputAdornment position="end">
                                    <IconButton
                                        onClick={handleSendMessage}
                                        disabled={!inputValue.trim() || isLoading || choices.length > 0 || disableInput}
                                        color="primary"
                                        sx={{
                                            p: 1,
                                            bgcolor: inputValue.trim() ? 'primary.main' : 'transparent',
                                            color: inputValue.trim() ? 'primary.contrastText' : 'text.disabled',
                                            '&:hover': {
                                                bgcolor: inputValue.trim() ? 'primary.dark' : 'transparent'
                                            },
                                            '&.Mui-disabled': {
                                                bgcolor: 'transparent',
                                                color: 'text.disabled'
                                            }
                                        }}
                                    >
                                        <SendIcon fontSize="small" />
                                    </IconButton>
                                </InputAdornment>
                            )
                        }}
                    />
                </Box>
            </Box>

            {/* Multi-step Clean Report Dialog */}
            {hasCompletedMultiStep && (
                <MultiStepReport
                    open={isReportOpen}
                    onClose={handleCloseReport}
                    reportData={multiStepData}
                />
            )}
        </Box>
    );
};

export default ChatArea;