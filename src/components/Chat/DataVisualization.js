import React, { useState } from 'react';
import {
    Box,
    Typography,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Paper,
    IconButton,
    Menu,
    MenuItem,
    CircularProgress
} from '@mui/material';
import { MoreVert as MoreVertIcon } from '@mui/icons-material';
import {
    Chart as ChartJS,
    CategoryScale,
    LinearScale,
    BarElement,
    LineElement,
    PointElement,
    Title,
    Tooltip,
    Legend,
    ArcElement,
} from 'chart.js';
import { Bar, Line, Pie } from 'react-chartjs-2';
import { Boxdataset } from '../ui_components/boxdataset';

// Register Chart.js components
ChartJS.register(
    CategoryScale,
    LinearScale,
    BarElement,
    LineElement,
    PointElement,
    Title,
    Tooltip,
    Legend,
    ArcElement
);

// Color palette for charts
const COLORS = [
    '#10a37f', '#007AFF', '#FF6B6B', '#4ECDC4', '#45B7D1',
    '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'
];

// Chart.js options
const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
        legend: {
            position: 'top',
            labels: {
                usePointStyle: true,
                padding: 20,
                font: {
                    size: 12
                }
            }
        },
        title: {
            display: false
        },
    },
};

const DataVisualization = ({ visualizationData, onSaveToMain, boxClickFunction, isLoading = false, hideMenu = false, compact = false }) => {
    const [anchorEl, setAnchorEl] = useState(null);
    const open = Boolean(anchorEl);

    // Use responsive height in compact mode (for reports/presentations)
    const chartHeight = compact ? '90%' : '400px';

    if (!visualizationData) {
        return null;
    }

    // Determine if we should show the menu (only in ChatBot context and when hideMenu is false)
    const showMenu = !hideMenu && onSaveToMain !== null;
    
    // Determine if we should show the title and container box
    // In chat: show container for ALL types (including box)
    // In dashboard: show container for all types EXCEPT box
    const showContainer = onSaveToMain !== null || (onSaveToMain === null && visualizationData.type !== 'box');
    const showTitle = showContainer;

    const handleMenuClick = (event) => {
        setAnchorEl(event.currentTarget);
    };

    const handleMenuClose = () => {
        setAnchorEl(null);
    };

    const handleSaveToMain = () => {
        if (onSaveToMain) {
            onSaveToMain(visualizationData);
        }
        handleMenuClose();
    };

    const renderChart = () => {
        switch (visualizationData.type) {
            case 'bar':
                if (isLoading) {
                    return (
                        <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <CircularProgress />
                        </div>
                    );
                }
                
                const barData = {
                    labels: visualizationData.data.map(item => item.x),
                    datasets: [
                        {
                            label: visualizationData.yAxisLabel || 'Value',
                            data: visualizationData.data.map(item => item.y),
                            backgroundColor: COLORS[0],
                            borderColor: COLORS[0],
                            borderWidth: 1,
                        },
                    ],
                };

                const barOptions = {
                    ...chartOptions,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                font: { size: 11 }
                            }
                        },
                        x: {
                            ticks: {
                                font: { size: 11 },
                                maxRotation: 45,
                                minRotation: 0
                            }
                        }
                    }
                };

                return (
                    <div style={{ height: chartHeight }}>
                        <Bar data={barData} options={barOptions} />
                    </div>
                );

            case 'line':
                if (isLoading) {
                    return (
                        <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <CircularProgress />
                        </div>
                    );
                }
                
                const lineData = {
                    labels: visualizationData.data.map(item => item.x),
                    datasets: [
                        {
                            label: visualizationData.yAxisLabel || 'Value',
                            data: visualizationData.data.map(item => item.y),
                            borderColor: COLORS[1],
                            backgroundColor: COLORS[1] + '20',
                            borderWidth: 3,
                            fill: true,
                            tension: 0.4,
                        },
                    ],
                };

                const lineOptions = {
                    ...chartOptions,
                    scales: {
                        y: {
                            beginAtZero: true,
                            ticks: {
                                font: { size: 11 }
                            }
                        },
                        x: {
                            ticks: {
                                font: { size: 11 },
                                maxRotation: 45,
                                minRotation: 0
                            }
                        }
                    }
                };

                return (
                    <div style={{ height: chartHeight }}>
                        <Line data={lineData} options={lineOptions} />
                    </div>
                );

            case 'pie':
                if (isLoading) {
                    return (
                        <div style={{ height: '400px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <CircularProgress />
                        </div>
                    );
                }
                
                const pieData = {
                    labels: visualizationData.data.map(item => item.name),
                    datasets: [
                        {
                            data: visualizationData.data.map(item => item.value),
                            backgroundColor: COLORS.slice(0, visualizationData.data.length),
                            borderColor: '#ffffff',
                            borderWidth: 2,
                        },
                    ],
                };

                const pieOptions = {
                    ...chartOptions,
                    plugins: {
                        ...chartOptions.plugins,
                        tooltip: {
                            callbacks: {
                                label: (context) => {
                                    const total = context.dataset.data.reduce((sum, value) => sum + value, 0);
                                    const percentage = ((context.parsed / total) * 100).toFixed(1);
                                    return `${context.label}: ${context.parsed} (${percentage}%)`;
                                }
                            }
                        }
                    }
                };

                return (
                    <div style={{ height: chartHeight }}>
                        <Pie data={pieData} options={pieOptions} />
                    </div>
                );

            case 'table':
                if (isLoading) {
                    return (
                        <TableContainer component={Paper} sx={{ maxHeight: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            <CircularProgress sx={{ my: 10 }} />
                        </TableContainer>
                    );
                }
                
                return (
                    <TableContainer component={Paper} sx={{ maxHeight: 400 }}>
                        <Table stickyHeader size="small">
                            <TableHead>
                                <TableRow>
                                    {visualizationData.columns.map((column, index) => (
                                        <TableCell 
                                            key={index}
                                            sx={{ 
                                                backgroundColor: '#f5f5f5',
                                                fontWeight: 600,
                                                fontSize: 12,
                                                minWidth: 150
                                            }}
                                        >
                                            {column}
                                        </TableCell>
                                    ))}
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {visualizationData.data.map((row, rowIndex) => (
                                    <TableRow key={rowIndex}>
                                        {visualizationData.columns.map((column, colIndex) => (
                                            <TableCell 
                                                key={colIndex}
                                                sx={{ fontSize: 11 }}
                                            >
                                                {row[column]}
                                            </TableCell>
                                        ))}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                );

            case 'box':
                // Box visualization data structure from workflow-analysis endpoint
                const boxData = visualizationData.data || {};
                const rawCurrentValue = visualizationData.currentValue || boxData.total_current;
                const rawPreviousValue = visualizationData.previousValue || boxData.total_past;

                // Round to 2 decimal places
                const currentValue = typeof rawCurrentValue === 'number'
                    ? Math.round(rawCurrentValue * 100) / 100
                    : rawCurrentValue;
                const previousValue = typeof rawPreviousValue === 'number'
                    ? Math.round(rawPreviousValue * 100) / 100
                    : rawPreviousValue;

                // Calculate change if not provided
                const calculatedChange = (currentValue && previousValue) ?
                    Math.round((currentValue - previousValue) / previousValue * 100) / 100 : 0;

                return (
                    <div style={{ height: 'auto', padding: '0' }}>
                        <Boxdataset
                            boxClickFunction={boxClickFunction || (() => {})}
                            classnameval={`box-container ${!previousValue && 'pb-70'}`}
                            exportInd={false}
                            starredval={true}
                            margin={154}
                            unsetarrangement={() => {}}
                            setarrangement={() => {}}
                            zoom={0}
                            arrangement={1}
                            arrangestar={true}
                            type={!isLoading}
                            top_text={visualizationData.title || 'Metric'}
                            mid_text={visualizationData.title || 'Metric'}
                            total_diff={calculatedChange}
                            total_current={currentValue}
                            total_past={previousValue}
                            description={visualizationData.description || `Current vs previous ${visualizationData.title || 'metric'}`}
                            filters={{}}
                        />
                    </div>
                );

            default:
                return null;
        }
    };

    return (
        <Box
            sx={{
                mt: 2,
                height: '90%',
                p: showContainer ? 2 : 0, // Show container styling only in chat
                backgroundColor: showContainer ? '#f8f9fa' : 'transparent',
                borderRadius: showContainer ? '12px' : 0,
                border: showContainer ? '1px solid #e9ecef' : 'none',
                position: 'relative'
            }}
        >
            {/* 3-dots menu in top right - only show in ChatBot context */}
            {showMenu && (
                <>
                    <IconButton
                        onClick={handleMenuClick}
                        sx={{
                            position: 'absolute',
                            top: 8,
                            right: 8,
                            color: '#6b7280',
                            '&:hover': {
                                backgroundColor: '#f3f4f6'
                            }
                        }}
                        size="small"
                    >
                        <MoreVertIcon fontSize="small" />
                    </IconButton>

                    <Menu
                        anchorEl={anchorEl}
                        open={open}
                        onClose={handleMenuClose}
                        anchorOrigin={{
                            vertical: 'bottom',
                            horizontal: 'right',
                        }}
                        transformOrigin={{
                            vertical: 'top',
                            horizontal: 'right',
                        }}
                    >
                        <MenuItem onClick={handleSaveToMain}>
                            Save to main page
                        </MenuItem>
                    </Menu>
                </>
            )}

            {/* Title - hide for box type since Boxdataset has its own title */}
            {showTitle && (
                <Typography
                    variant="h6"
                    sx={{
                        mb: 2,
                        fontSize: 16,
                        fontWeight: 600,
                        color: '#2d3748',
                        textAlign: 'center',
                        pr: showMenu ? 4 : 0 // Add padding only if menu is shown
                    }}
                >
                    {visualizationData.title}
                </Typography>
            )}
            
            {renderChart()}
        </Box>
    );
};

export default DataVisualization;