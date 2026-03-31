import React, { useState } from 'react';
import axios from 'axios';
import {
  Box,
  Typography,
  TextField,
  Button,
  InputAdornment,
  IconButton,
  CircularProgress,
  Link,
  Stepper,
  Step,
  StepLabel,
  StepContent,
  Paper,
  Chip,
  Alert,
  Tabs,
  Tab,
  Card,
  CardContent,
  Divider,
} from '@mui/material';
import {
  Visibility,
  VisibilityOff,
  CheckCircle,
  OpenInNew,
  KeyOutlined,
  PersonOutlined,
  ArrowBack,
  CheckRounded,
  WorkspacePremium,
} from '@mui/icons-material';
import { saveApiKey } from '../../utils/apiKeyStorage';

// ─────────────────────────────────────────────────────────────────────────────
// Static data
// ─────────────────────────────────────────────────────────────────────────────

const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    price: 'Free',
    period: '',
    highlight: false,
    cta: 'Get Started',
    color: '#64748b',
    features: [
      'Up to 50 AI queries / month',
      '2 active workflows',
      'Basic data connectors',
      'Community support',
      'CSV & Excel uploads',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$29',
    period: '/ mo',
    highlight: true,
    cta: 'Get Started',
    color: '#6366f1',
    features: [
      'Unlimited AI queries',
      '10 active workflows',
      'All data connectors',
      'Multi-step analysis',
      'Workflow scheduling',
      'Priority email support',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: '$99',
    period: '/ mo',
    highlight: false,
    cta: 'Contact Sales',
    color: '#0f172a',
    features: [
      'Everything in Pro',
      'Unlimited workflows',
      'Custom integrations',
      'SSO & team seats',
      'Dedicated support',
      'SLA guarantee',
    ],
  },
];

const PROVIDERS = [
  {
    id: 'claude',
    name: 'Claude',
    company: 'Anthropic',
    bgColor: '#fefae0',
    borderColor: '#d4a373',
    keyPrefix: 'sk-ant-',
    keyPlaceholder: 'sk-ant-api03-...',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    logo: (selected) => (
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill={selected ? '#fefae0' : '#d4a373'} />
        <text x="16" y="22" textAnchor="middle" fontSize="16" fontWeight="bold" fill={selected ? '#6b4226' : '#fff'}>C</text>
      </svg>
    ),
    steps: [
      { label: 'Go to the Anthropic Console', detail: 'Open console.anthropic.com and sign in to your account.' },
      { label: 'Navigate to API Keys', detail: 'Click "Settings" in the left sidebar, then select "API Keys".' },
      { label: 'Create a new key', detail: 'Click "Create Key", give it a name, then copy it — it starts with sk-ant-.' },
    ],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    company: 'Google',
    bgColor: '#e8f0fe',
    borderColor: '#4285f4',
    keyPrefix: 'AIza',
    keyPlaceholder: 'AIzaSy...',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    logo: (selected) => (
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill={selected ? '#e8f0fe' : '#4285f4'} />
        <text x="16" y="22" textAnchor="middle" fontSize="16" fontWeight="bold" fill={selected ? '#1a73e8' : '#fff'}>G</text>
      </svg>
    ),
    steps: [
      { label: 'Open Google AI Studio', detail: 'Go to aistudio.google.com and sign in with your Google account.' },
      { label: 'Get an API Key', detail: 'Click "Get API Key" in the left sidebar.' },
      { label: 'Create API key', detail: 'Choose a project and click "Create API key". It starts with AIza.' },
    ],
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    company: 'OpenAI',
    bgColor: '#e6f4f1',
    borderColor: '#10a37f',
    keyPrefix: 'sk-',
    keyPlaceholder: 'sk-proj-...',
    docsUrl: 'https://platform.openai.com/api-keys',
    logo: (selected) => (
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill={selected ? '#e6f4f1' : '#10a37f'} />
        <text x="16" y="22" textAnchor="middle" fontSize="16" fontWeight="bold" fill={selected ? '#0d7a5f' : '#fff'}>O</text>
      </svg>
    ),
    steps: [
      { label: 'Open the OpenAI Platform', detail: 'Go to platform.openai.com and sign in.' },
      { label: 'Navigate to API Keys', detail: 'Click your profile icon → "API keys".' },
      { label: 'Create a secret key', detail: 'Click "Create new secret key", copy it immediately — starts with sk-proj-.' },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// SignInView  —  default landing; login form only
// ─────────────────────────────────────────────────────────────────────────────

const SignInView = ({ onRegister, onComplete, isSettingsMode = false }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSignIn = async () => {
    if (!email.trim()) { setError('Email is required.'); return; }
    if (!password)     { setError('Password is required.'); return; }

    setSubmitting(true);
    setError('');
    try {
      const response = await axios.post('/auth/login', { email: email.trim(), password });
      if (response.data.success && response.data.token) {
        localStorage.setItem('auth-token', response.data.token);
        setSuccess(true);
        setTimeout(() => onComplete({ via: 'account' }), 800);
      } else {
        setError(response.data.error || 'Authentication failed. Please try again.');
      }
    } catch (err) {
      setError(
        err.response?.data?.error ||
        err.response?.data?.message ||
        'Unable to connect. Please check your connection and try again.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !submitting) handleSignIn();
  };

  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        alignItems: isSettingsMode ? 'flex-start' : 'center',
        justifyContent: 'center',
        p: isSettingsMode ? 0 : 4,
        pt: isSettingsMode ? 3 : 4,
        bgcolor: isSettingsMode ? 'transparent' : '#f8f9fa',
      }}
    >
      <Paper
        elevation={isSettingsMode ? 0 : 0}
        variant={isSettingsMode ? 'elevation' : 'outlined'}
        sx={{ width: '100%', maxWidth: 400, borderRadius: isSettingsMode ? 0 : 3, p: isSettingsMode ? 0 : 4, border: isSettingsMode ? 'none' : undefined }}
      >
        <Typography variant="h5" fontWeight={800} mb={0.5}>
          Welcome back
        </Typography>
        <Typography variant="body2" color="text.secondary" mb={3}>
          Sign in to continue to DagFlux.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
            {error}
          </Alert>
        )}
        {success && (
          <Alert severity="success" sx={{ mb: 2, borderRadius: 2 }}>
            Signed in! Loading DagFlux...
          </Alert>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(''); }}
            onKeyDown={handleKeyDown}
            size="small"
            fullWidth
            autoFocus
            autoComplete="email"
            disabled={submitting || success}
          />

          <TextField
            label="Password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            onKeyDown={handleKeyDown}
            size="small"
            fullWidth
            autoComplete="current-password"
            disabled={submitting || success}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setShowPassword(v => !v)} edge="end">
                    {showPassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />

          <Button
            variant="contained"
            fullWidth
            onClick={handleSignIn}
            disabled={submitting || success}
            // startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : <CheckCircle />}
            sx={{ borderRadius: 2, fontWeight: 700, py: 1.1 }}
          >
            {submitting ? 'Signing in...' : 'Sign In'}
          </Button>
        </Box>

        <Divider sx={{ my: 3 }}>
          <Typography variant="caption" color="text.disabled">or</Typography>
        </Divider>

        <Box sx={{ textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary" mb={1.5}>
            New to DagFlux?
          </Typography>
          <Button
            variant="outlined"
            fullWidth
            onClick={onRegister}
            sx={{ borderRadius: 2, fontWeight: 700, textTransform: 'none' }}
          >
            VIEW PLANS
          </Button>
        </Box>
      </Paper>
    </Box>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// PricingRegisterPage  —  full-page pricing cards + register form
// ─────────────────────────────────────────────────────────────────────────────

const PricingRegisterPage = ({ onBack, onComplete, isSettingsMode = false }) => {
  const [selectedPlan, setSelectedPlan] = useState('pro'); // pre-select Most Popular
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const selectedPlanObj = PLANS.find(p => p.id === selectedPlan);

  const validate = () => {
    if (!name.trim())        return 'Full name is required.';
    if (!email.trim())       return 'Email is required.';
    if (!password)           return 'Password is required.';
    if (password.length < 8) return 'Password must be at least 8 characters.';
    if (password !== confirmPassword) return 'Passwords do not match.';
    return null;
  };

  const handleRegister = async () => {
    const err = validate();
    if (err) { setError(err); return; }

    setSubmitting(true);
    setError('');
    try {
      const response = await axios.post('/auth/register', {
        name: name.trim(),
        email: email.trim(),
        password,
        plan: selectedPlan,
      });
      if (response.data.success && response.data.token) {
        localStorage.setItem('auth-token', response.data.token);
        setSuccess(true);
        setTimeout(() => onComplete({ via: 'account' }), 800);
      } else {
        setError(response.data.error || 'Registration failed. Please try again.');
      }
    } catch (err) {
      setError(
        err.response?.data?.error ||
        err.response?.data?.message ||
        'Unable to connect. Please check your connection and try again.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !submitting) handleRegister();
  };

  return (
    <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden', flexDirection: isSettingsMode ? 'column' : 'row' }}>

      {/* ── Left: Pricing cards ── */}
      <Box
        sx={{
          flex: isSettingsMode ? '1' : '0 0 58%',
          p: isSettingsMode ? 0 : 4,
          pt: isSettingsMode ? 3 : 3,
          borderRight: isSettingsMode ? 'none' : '1px solid',
          borderColor: 'divider',
          overflowY: 'auto',
          bgcolor: isSettingsMode ? 'transparent' : '#f8f9fa',
        }}
      >
        {/* Back link */}
        <Button
          startIcon={<ArrowBack />}
          size="small"
          onClick={onBack}
          sx={{ mb: 3, color: 'text.secondary', textTransform: 'none', fontWeight: 600, pl: 0 }}
        >
          Back to Sign In
        </Button>

        <Typography variant="h5" fontWeight={800} mb={0.5}>
          Simple, transparent pricing
        </Typography>
        <Typography variant="body2" color="text.secondary" mb={4}>
          Start free. Upgrade when you're ready.
        </Typography>

        {/* Cards — mt gives room for the "Most Popular" badge that peeks above */}
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'stretch', mt: '20px' }}>
          {PLANS.map((plan) => {
            const isSelected = selectedPlan === plan.id;
            return (
              <Box key={plan.id} sx={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column' }}>

                {/* Most Popular badge — rendered outside Card so it's never clipped */}
                {plan.highlight && (
                  <Box
                    sx={{
                      position: 'absolute',
                      top: -14,
                      left: '50%',
                      transform: 'translateX(-50%)',
                      bgcolor: plan.color,
                      color: '#fff',
                      px: 1.5,
                      py: 0.5,
                      borderRadius: 10,
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: 0.4,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.5,
                      whiteSpace: 'nowrap',
                      zIndex: 1,
                      boxShadow: `0 2px 8px ${plan.color}55`,
                    }}
                  >
                    <WorkspacePremium sx={{ fontSize: 13 }} />
                    Most Popular
                  </Box>
                )}

                <Card
                  variant="outlined"
                  onClick={() => setSelectedPlan(plan.id)}
                  sx={{
                    flex: 1,
                    borderRadius: 3,
                    borderWidth: 2,
                    borderColor: isSelected ? plan.color : plan.highlight ? `${plan.color}55` : 'divider',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease',
                    display: 'flex',
                    flexDirection: 'column',
                    boxShadow: plan.highlight ? `0 4px 20px ${plan.color}20` : 'none',
                    bgcolor: isSelected ? `${plan.color}06` : 'background.paper',
                    '&:hover': {
                      borderColor: plan.color,
                      boxShadow: `0 4px 16px ${plan.color}25`,
                    },
                    // No overflow:hidden — let the badge live outside
                  }}
                >
                  <CardContent sx={{ flex: 1, pt: 2.5, pb: 1.5 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.5 }}>
                      <Typography variant="subtitle1" fontWeight={700} color={plan.color}>
                        {plan.name}
                      </Typography>
                      {isSelected && <CheckCircle sx={{ fontSize: 18, color: plan.color }} />}
                    </Box>

                    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, mb: 2 }}>
                      <Typography variant="h4" fontWeight={800} lineHeight={1}>
                        {plan.price}
                      </Typography>
                      {plan.period && (
                        <Typography variant="body2" color="text.secondary">
                          {plan.period}
                        </Typography>
                      )}
                    </Box>

                    <Divider sx={{ mb: 2 }} />

                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {plan.features.map((feat, i) => (
                        <Box key={i} sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
                          <CheckRounded sx={{ fontSize: 15, color: plan.color, mt: 0.25, flexShrink: 0 }} />
                          <Typography variant="body2" color="text.secondary" lineHeight={1.4}>
                            {feat}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  </CardContent>

                  <Box sx={{ px: 2, pb: 2, pt: 1 }}>
                    <Button
                      fullWidth
                      variant={isSelected ? 'contained' : 'outlined'}
                      size="small"
                      onClick={(e) => { e.stopPropagation(); setSelectedPlan(plan.id); }}
                      sx={{
                        borderRadius: 2,
                        fontWeight: 700,
                        fontSize: 13,
                        textTransform: 'none',
                        ...(isSelected
                          ? { bgcolor: plan.color, '&:hover': { bgcolor: plan.color, filter: 'brightness(0.9)' } }
                          : { borderColor: plan.color, color: plan.color, '&:hover': { borderColor: plan.color, bgcolor: `${plan.color}10` } }),
                      }}
                    >
                      {plan.cta}
                    </Button>
                  </Box>
                </Card>
              </Box>
            );
          })}
        </Box>
      </Box>

      {/* ── Right: Register form ── */}
      <Box
        sx={{
          flex: 1,
          p: isSettingsMode ? 0 : 4,
          pt: isSettingsMode ? 3 : 4,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: isSettingsMode ? 'flex-start' : 'center',
          overflowY: 'auto',
          bgcolor: isSettingsMode ? 'transparent' : 'background.paper',
        }}
      >
        <Typography variant="h6" fontWeight={700} mb={0.5}>
          Create your account
        </Typography>
        <Typography variant="body2" color="text.secondary" mb={2.5}>
          Get started with DagFlux in seconds.
        </Typography>

        {/* Selected plan chip */}
        {selectedPlanObj && (
          <Box sx={{ mb: 2.5 }}>
            <Typography variant="caption" color="text.secondary" fontWeight={600} display="block" mb={0.5}>
              SELECTED PLAN
            </Typography>
            <Chip
              label={`${selectedPlanObj.name} — ${selectedPlanObj.price}${selectedPlanObj.period}`}
              size="small"
              sx={{
                bgcolor: `${selectedPlanObj.color}15`,
                color: selectedPlanObj.color,
                fontWeight: 700,
                borderRadius: 1.5,
              }}
            />
          </Box>
        )}

        {error && (
          <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
            {error}
          </Alert>
        )}
        {success && (
          <Alert severity="success" sx={{ mb: 2, borderRadius: 2 }}>
            Account created! Loading DagFlux...
          </Alert>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <TextField
            label="Full name"
            value={name}
            onChange={(e) => { setName(e.target.value); setError(''); }}
            onKeyDown={handleKeyDown}
            size="small"
            fullWidth
            autoFocus
            disabled={submitting || success}
          />

          <TextField
            label="Email"
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); setError(''); }}
            onKeyDown={handleKeyDown}
            size="small"
            fullWidth
            autoComplete="email"
            disabled={submitting || success}
          />

          <TextField
            label="Password"
            type={showPassword ? 'text' : 'password'}
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            onKeyDown={handleKeyDown}
            size="small"
            fullWidth
            autoComplete="new-password"
            helperText="Minimum 8 characters"
            disabled={submitting || success}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setShowPassword(v => !v)} edge="end">
                    {showPassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />

          <TextField
            label="Confirm password"
            type={showConfirm ? 'text' : 'password'}
            value={confirmPassword}
            onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
            onKeyDown={handleKeyDown}
            size="small"
            fullWidth
            autoComplete="new-password"
            disabled={submitting || success}
            InputProps={{
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton size="small" onClick={() => setShowConfirm(v => !v)} edge="end">
                    {showConfirm ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                  </IconButton>
                </InputAdornment>
              ),
            }}
          />

          <Button
            variant="contained"
            fullWidth
            onClick={handleRegister}
            disabled={submitting || success}
            startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : <CheckCircle />}
            sx={{ borderRadius: 2, fontWeight: 700, py: 1.1, mt: 0.5 }}
          >
            {submitting ? 'Creating account...' : 'Create Account'}
          </Button>
        </Box>

        <Divider sx={{ my: 2.5 }}>
          <Typography variant="caption" color="text.disabled">or</Typography>
        </Divider>

        <Typography variant="body2" color="text.secondary" textAlign="center">
          Already have an account?{' '}
          <Link
            component="button"
            variant="body2"
            fontWeight={600}
            underline="hover"
            onClick={onBack}
          >
            Sign in
          </Link>
        </Typography>
      </Box>
    </Box>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// BringYourOwnKey  —  provider selection + key input (unchanged logic)
// ─────────────────────────────────────────────────────────────────────────────

const BringYourOwnKey = ({ onComplete, isSettingsMode = false }) => {
  const [selectedProvider, setSelectedProvider] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const provider = PROVIDERS.find(p => p.id === selectedProvider);
  const canSave = selectedProvider && apiKey.trim().length > 0 && !saving;

  const handleProviderSelect = (id) => {
    setSelectedProvider(id);
    setApiKey('');
    setError('');
  };

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError('');
    try {
      const result = await saveApiKey(selectedProvider, apiKey.trim());
      if (result?.success === false) {
        setError(result.error || 'Failed to save API key.');
        return;
      }
      setSaved(true);
      setTimeout(() => onComplete({ provider: selectedProvider, key: apiKey.trim() }), 900);
    } catch (err) {
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && canSave) handleSave();
  };

  return (
    <Box sx={{ flex: 1, display: 'flex', overflow: 'hidden', flexDirection: isSettingsMode ? 'column' : 'row' }}>
      {/* Provider list */}
      <Box
        sx={{
          width: isSettingsMode ? '100%' : 260,
          flexShrink: 0,
          borderRight: isSettingsMode ? 'none' : '1px solid',
          borderBottom: isSettingsMode ? '1px solid' : 'none',
          borderColor: 'divider',
          bgcolor: isSettingsMode ? 'transparent' : 'background.paper',
          p: isSettingsMode ? 0 : 3,
          pt: isSettingsMode ? 3 : 3,
          pb: isSettingsMode ? 3 : 3,
          display: 'flex',
          flexDirection: isSettingsMode ? 'row' : 'column',
          gap: 1.5,
          overflowY: 'auto',
          overflowX: isSettingsMode ? 'auto' : 'visible',
        }}
      >
        {!isSettingsMode && (
          <Typography variant="body2" color="text.secondary" fontWeight={600} mb={1}>
            CHOOSE YOUR PROVIDER
          </Typography>
        )}
        {PROVIDERS.map((p) => {
          const isSelected = selectedProvider === p.id;
          return (
            <Box
              key={p.id}
              onClick={() => handleProviderSelect(p.id)}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                p: 2,
                borderRadius: 2,
                border: '2px solid',
                borderColor: isSelected ? p.borderColor : 'transparent',
                bgcolor: isSelected ? p.bgColor : 'grey.50',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
                '&:hover': { borderColor: p.borderColor, bgcolor: p.bgColor },
              }}
            >
              {p.logo(isSelected)}
              <Box flex={1}>
                <Typography variant="body1" fontWeight={600} lineHeight={1.2}>{p.name}</Typography>
                <Typography variant="caption" color="text.secondary">{p.company}</Typography>
              </Box>
              {isSelected && <CheckCircle sx={{ color: p.borderColor, fontSize: 20 }} />}
            </Box>
          );
        })}
      </Box>

      {/* Right panel */}
      <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', bgcolor: isSettingsMode ? 'transparent' : 'background.default' }}>
        {!selectedProvider ? (
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              color: 'text.disabled',
              p: 4,
            }}
          >
            <KeyOutlined sx={{ fontSize: 56, opacity: 0.3 }} />
            <Typography variant="h6" fontWeight={500}>Select a provider to continue</Typography>
            <Typography variant="body2" textAlign="center" maxWidth={380}>
              Choose Claude, Gemini, or ChatGPT and we'll show you exactly how to get your API key.
            </Typography>
          </Box>
        ) : (
          <Box sx={{ p: 4, maxWidth: 660 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
              {provider.logo(false)}
              <Box>
                <Typography variant="h5" fontWeight={700}>{provider.name}</Typography>
                <Chip
                  size="small"
                  label={provider.company}
                  sx={{ bgcolor: provider.bgColor, color: provider.borderColor, fontWeight: 600, fontSize: 11, mt: 0.5 }}
                />
              </Box>
            </Box>

            <Paper variant="outlined" sx={{ p: 3, mb: 4, borderRadius: 2 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                <Typography variant="subtitle1" fontWeight={700}>How to get your API key</Typography>
                <Link
                  href={provider.docsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  underline="hover"
                  sx={{ display: 'flex', alignItems: 'center', gap: 0.5, fontSize: 13, color: provider.borderColor, fontWeight: 600 }}
                >
                  Open {provider.company} <OpenInNew sx={{ fontSize: 14 }} />
                </Link>
              </Box>
              <Stepper orientation="vertical" nonLinear activeStep={-1}>
                {provider.steps.map((step, i) => (
                  <Step key={i} active>
                    <StepLabel StepIconProps={{ sx: { color: `${provider.borderColor} !important`, '& .MuiStepIcon-text': { fill: '#fff' } } }}>
                      <Typography variant="body2" fontWeight={600}>{step.label}</Typography>
                    </StepLabel>
                    <StepContent>
                      <Typography variant="body2" color="text.secondary" mb={1}>{step.detail}</Typography>
                    </StepContent>
                  </Step>
                ))}
              </Stepper>
            </Paper>

            <Typography variant="subtitle1" fontWeight={700} mb={1}>Paste your API key</Typography>
            <Typography variant="body2" color="text.secondary" mb={2}>
              Your key is encrypted and stored securely on this device using your OS keychain. It never leaves your machine.
            </Typography>

            <TextField
              fullWidth
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setError(''); }}
              onKeyDown={handleKeyDown}
              placeholder={provider.keyPlaceholder}
              type={showKey ? 'text' : 'password'}
              autoComplete="off"
              autoFocus
              error={Boolean(error)}
              helperText={error || `Keys for ${provider.name} typically start with "${provider.keyPrefix}"`}
              InputProps={{
                endAdornment: (
                  <InputAdornment position="end">
                    <IconButton onClick={() => setShowKey(v => !v)} edge="end" size="small">
                      {showKey ? <VisibilityOff /> : <Visibility />}
                    </IconButton>
                  </InputAdornment>
                ),
              }}
              sx={{ mb: 3 }}
            />

            {saved && (
              <Alert severity="success" sx={{ mb: 2 }}>
                API key saved! Loading DagFlux...
              </Alert>
            )}

            <Button
              variant="contained"
              size="large"
              onClick={handleSave}
              disabled={!canSave || saved}
              startIcon={saving ? <CircularProgress size={18} color="inherit" /> : <CheckCircle />}
              sx={{
                bgcolor: provider.borderColor,
                '&:hover': { bgcolor: provider.borderColor, filter: 'brightness(0.9)' },
                px: 4, py: 1.2, fontWeight: 700, fontSize: 15, borderRadius: 2,
              }}
            >
              {saving ? 'Saving...' : saved ? 'Saved!' : 'Save & Continue'}
            </Button>
          </Box>
        )}
      </Box>
    </Box>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Root
// ─────────────────────────────────────────────────────────────────────────────

const ApiKeySetup = ({ onComplete, isSettingsMode = false }) => {
  // 'signin' | 'pricing' | 'byok'
  const [view, setView] = useState('signin');

  // Tabs: 0 = account path (signin / pricing), 1 = byok
  const tabValue = view === 'byok' ? 1 : 0;

  const handleTabChange = (_, newValue) => {
    if (newValue === 0) setView('signin');
    else setView('byok');
  };

  // Different styling for settings mode vs full-screen mode
  const containerStyles = isSettingsMode
    ? {
        display: 'flex',
        flexDirection: 'column',
        bgcolor: 'transparent',
        height: '100%',
      }
    : {
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: '#f8f9fa',
        zIndex: 9999,
      };

  const headerStyles = isSettingsMode
    ? {
        px: 0,
        pt: 0,
        pb: 2,
        borderBottom: '1px solid',
        borderColor: 'divider',
        bgcolor: 'transparent',
      }
    : {
        px: 4,
        pt: 2.5,
        borderBottom: '1px solid',
        borderColor: 'divider',
        bgcolor: 'background.paper',
      };

  return (
    <Box sx={containerStyles}>
      {/* ── Header ── */}
      <Box sx={headerStyles}>
        {!isSettingsMode && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
            <KeyOutlined sx={{ color: 'primary.main', fontSize: 28 }} />
            <Box>
              <Typography variant="h6" fontWeight={700} lineHeight={1.2}>
                DagFlux — Get Started
              </Typography>
              <Typography variant="caption" color="text.secondary">
                Create an account or connect your own LLM provider
              </Typography>
            </Box>
          </Box>
        )}

        <Tabs
          value={tabValue}
          onChange={handleTabChange}
          sx={{
            '& .MuiTab-root': { fontWeight: 600, fontSize: 14, textTransform: 'none', minHeight: 40 },
          }}
        >
          <Tab icon={<PersonOutlined sx={{ fontSize: 18 }} />} iconPosition="start" label="Sign In / Register" />
          <Tab icon={<KeyOutlined sx={{ fontSize: 18 }} />} iconPosition="start" label="Use My Own Key" />
        </Tabs>
      </Box>

      {/* ── Body ── */}
      <Box sx={{ flex: 1, display: 'flex', overflow: isSettingsMode ? 'auto' : 'hidden' }}>
        {view === 'signin' && (
          <SignInView
            onRegister={() => setView('pricing')}
            onComplete={onComplete}
            isSettingsMode={isSettingsMode}
          />
        )}
        {view === 'pricing' && (
          <PricingRegisterPage
            onBack={() => setView('signin')}
            onComplete={onComplete}
            isSettingsMode={isSettingsMode}
          />
        )}
        {view === 'byok' && (
          <BringYourOwnKey onComplete={onComplete} isSettingsMode={isSettingsMode} />
        )}
      </Box>
    </Box>
  );
};

export default ApiKeySetup;
