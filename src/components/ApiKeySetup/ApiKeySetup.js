import React, { useState, useEffect } from 'react';
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
  Divider,
  Avatar,
} from '@mui/material';
import {
  Visibility,
  VisibilityOff,
  CheckCircle,
  OpenInNew,
  KeyOutlined,
  ArrowBack,
  MarkEmailReadOutlined,
  Google,
  // Apple, // Apple sign-in disabled
  LockOpenOutlined,
  Logout,
} from '@mui/icons-material';
import { saveApiKey } from '../../utils/apiKeyStorage';
import OthersProviderForm from './OthersProviderForm';
import {
  register as registerAccount,
  login as loginAccount,
  loginWithGoogle,
  // loginWithApple, // Apple sign-in disabled
  resendVerification,
  isLoggedIn,
  getStoredUser,
  fetchCurrentUser,
  signOut,
} from '../../utils/authService';

// ─────────────────────────────────────────────────────────────────────────────
// Static data
// ─────────────────────────────────────────────────────────────────────────────

// NOTE: Plans are disabled for now — accounts are free and only gate plugin
// access. Re-enable this section when paid plans come back.
// const PLANS = [
//   {
//     id: 'starter',
//     name: 'Starter',
//     price: 'Free',
//     period: '',
//     highlight: false,
//     cta: 'Get Started',
//     color: '#64748b',
//     features: [
//       'Up to 50 AI queries / month',
//       '2 active workflows',
//       'Basic data connectors',
//       'Community support',
//       'CSV & Excel uploads',
//     ],
//   },
//   {
//     id: 'pro',
//     name: 'Pro',
//     price: '$29',
//     period: '/ mo',
//     highlight: true,
//     cta: 'Get Started',
//     color: '#6366f1',
//     features: [
//       'Unlimited AI queries',
//       '10 active workflows',
//       'All data connectors',
//       'Multi-step analysis',
//       'Workflow scheduling',
//       'Priority email support',
//     ],
//   },
//   {
//     id: 'enterprise',
//     name: 'Enterprise',
//     price: '$99',
//     period: '/ mo',
//     highlight: false,
//     cta: 'Contact Sales',
//     color: '#0f172a',
//     features: [
//       'Everything in Pro',
//       'Unlimited workflows',
//       'Custom integrations',
//       'SSO & team seats',
//       'Dedicated support',
//       'SLA guarantee',
//     ],
//   },
// ];

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

// "Others" tile — OpenAI-compatible providers (OpenRouter, Groq, Together,
// Mistral, Ollama, LM Studio, or a custom endpoint). Handled by its own form
// rather than the single key-paste panel, so it has no steps/keyPrefix.
const OTHERS_TILE = {
  id: 'others',
  name: 'Others',
  company: 'OpenAI-compatible',
  bgColor: '#f0f0f0',
  borderColor: '#8c8c8c',
  logo: (selected) => (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="8" fill={selected ? '#f0f0f0' : '#8c8c8c'} />
      <circle cx="10" cy="16" r="2" fill={selected ? '#595959' : '#fff'} />
      <circle cx="16" cy="16" r="2" fill={selected ? '#595959' : '#fff'} />
      <circle cx="22" cy="16" r="2" fill={selected ? '#595959' : '#fff'} />
    </svg>
  ),
};

// ─────────────────────────────────────────────────────────────────────────────
// SocialButtons — shared "Continue with Google / Apple" buttons
// ─────────────────────────────────────────────────────────────────────────────

const SocialButton = ({ label, icon, accent, action, onSuccess, onError, disabled }) => {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    setBusy(true);
    onError('');
    try {
      const result = await action();
      if (result.success) {
        onSuccess(result);
      } else {
        onError(result.error || `${label} sign-in failed.`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      variant="outlined"
      fullWidth
      onClick={handleClick}
      disabled={disabled || busy}
      startIcon={busy ? <CircularProgress size={16} color="inherit" /> : icon}
      sx={{
        borderRadius: 2,
        fontWeight: 700,
        py: 1.05,
        textTransform: 'none',
        color: 'text.primary',
        borderColor: 'divider',
        '&:hover': { borderColor: accent, bgcolor: `${accent}08` },
      }}
    >
      {busy ? `Waiting for ${label}...` : `Continue with ${label}`}
    </Button>
  );
};

const SocialSignInButtons = ({ onSuccess, onError, disabled }) => (
  <>
    <SocialButton
      label="Google"
      icon={<Google sx={{ color: '#4285f4' }} />}
      accent="#4285f4"
      action={loginWithGoogle}
      onSuccess={onSuccess}
      onError={onError}
      disabled={disabled}
    />
    {/* Apple sign-in disabled
    <SocialButton
      label="Apple"
      icon={<Apple sx={{ color: '#000' }} />}
      accent="#000000"
      action={loginWithApple}
      onSuccess={onSuccess}
      onError={onError}
      disabled={disabled}
    />
    */}
  </>
);

// ─────────────────────────────────────────────────────────────────────────────
// SignInView — default landing; login form + Google
// ─────────────────────────────────────────────────────────────────────────────

const SignInView = ({ onRegister, onComplete, onNeedsVerification, onSkip = null, isSettingsMode = false }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const finish = () => {
    setSuccess(true);
    setTimeout(() => onComplete({ via: 'account' }), 800);
  };

  const handleSignIn = async () => {
    if (!email.trim()) { setError('Email is required.'); return; }
    if (!password)     { setError('Password is required.'); return; }

    setSubmitting(true);
    setError('');
    const result = await loginAccount({ email: email.trim(), password });
    setSubmitting(false);

    if (result.success) {
      finish();
    } else if (result.code === 'EMAIL_NOT_VERIFIED') {
      onNeedsVerification(email.trim());
    } else {
      setError(result.error || 'Authentication failed. Please try again.');
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
        elevation={0}
        variant={isSettingsMode ? 'elevation' : 'outlined'}
        sx={{ width: '100%', maxWidth: 400, borderRadius: isSettingsMode ? 0 : 3, p: isSettingsMode ? 0 : 4, border: isSettingsMode ? 'none' : undefined }}
      >
        <Typography variant="h5" fontWeight={800} mb={0.5}>
          Welcome back
        </Typography>
        <Typography variant="body2" color="text.secondary" mb={3}>
          Sign in to unlock plugin access in Ternlux.
        </Typography>

        {error && (
          <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
            {error}
          </Alert>
        )}
        {success && (
          <Alert severity="success" sx={{ mb: 2, borderRadius: 2 }}>
            Signed in! Loading Ternlux...
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
            sx={{ borderRadius: 2, fontWeight: 700, py: 1.1 }}
          >
            {submitting ? 'Signing in...' : 'Sign In'}
          </Button>

          <SocialSignInButtons onSuccess={finish} onError={setError} disabled={submitting || success} />
        </Box>

        <Divider sx={{ my: 3 }}>
          <Typography variant="caption" color="text.disabled">or</Typography>
        </Divider>

        <Box sx={{ textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary" mb={1.5}>
            New to Ternlux? Registration is free.
          </Typography>
          <Button
            variant="outlined"
            fullWidth
            onClick={onRegister}
            sx={{ borderRadius: 2, fontWeight: 700, textTransform: 'none' }}
          >
            Create a Free Account
          </Button>

          {onSkip && (
            <Button
              variant="text"
              fullWidth
              onClick={onSkip}
              disabled={submitting || success}
              sx={{ mt: 1.5, borderRadius: 2, fontWeight: 600, textTransform: 'none', color: 'text.secondary' }}
            >
              Skip for now
            </Button>
          )}
        </Box>
      </Paper>
    </Box>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// RegisterPage — free account registration (plans section commented out)
// ─────────────────────────────────────────────────────────────────────────────

const RegisterPage = ({ onBack, onComplete, onRegistered, isSettingsMode = false }) => {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

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
    const result = await registerAccount({
      name: name.trim(),
      email: email.trim(),
      password,
    });
    setSubmitting(false);

    if (result.success) {
      onRegistered(email.trim());
    } else {
      setError(result.error || 'Registration failed. Please try again.');
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !submitting) handleRegister();
  };

  const finishSocial = () => onComplete({ via: 'account' });

  return (
    <Box
      sx={{
        flex: 1,
        display: 'flex',
        alignItems: isSettingsMode ? 'flex-start' : 'center',
        justifyContent: 'center',
        p: isSettingsMode ? 0 : 4,
        pt: isSettingsMode ? 3 : 4,
        overflowY: 'auto',
        bgcolor: isSettingsMode ? 'transparent' : '#f8f9fa',
      }}
    >
      <Paper
        elevation={0}
        variant={isSettingsMode ? 'elevation' : 'outlined'}
        sx={{ width: '100%', maxWidth: 440, borderRadius: isSettingsMode ? 0 : 3, p: isSettingsMode ? 0 : 4, border: isSettingsMode ? 'none' : undefined }}
      >
        <Button
          startIcon={<ArrowBack />}
          size="small"
          onClick={onBack}
          sx={{ mb: 2, color: 'text.secondary', textTransform: 'none', fontWeight: 600, pl: 0 }}
        >
          Back to Sign In
        </Button>

        <Typography variant="h5" fontWeight={800} mb={0.5}>
          Create your free account
        </Typography>
        <Typography variant="body2" color="text.secondary" mb={2.5}>
          Register to unlock plugin access. We'll send a link to verify your email.
        </Typography>

        {/* Pricing cards are hidden while plans are disabled — see PLANS above. */}

        {error && (
          <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
            {error}
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
            disabled={submitting}
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
            disabled={submitting}
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
            disabled={submitting}
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
            disabled={submitting}
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
            disabled={submitting}
            startIcon={submitting ? <CircularProgress size={16} color="inherit" /> : <CheckCircle />}
            sx={{ borderRadius: 2, fontWeight: 700, py: 1.1, mt: 0.5 }}
          >
            {submitting ? 'Creating account...' : 'Create Free Account'}
          </Button>

          <SocialSignInButtons onSuccess={finishSocial} onError={setError} disabled={submitting} />
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
      </Paper>
    </Box>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// VerifyEmailView — shown after registering (or signing in unverified)
// ─────────────────────────────────────────────────────────────────────────────

const VerifyEmailView = ({ email, onBackToSignIn, isSettingsMode = false }) => {
  const [resending, setResending] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const handleResend = async () => {
    setResending(true);
    setNotice('');
    setError('');
    const result = await resendVerification(email);
    setResending(false);
    if (result.success) {
      setNotice('Verification email sent. Check your inbox (and spam folder).');
    } else {
      setError(result.error || 'Could not resend the verification email.');
    }
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
        elevation={0}
        variant={isSettingsMode ? 'elevation' : 'outlined'}
        sx={{ width: '100%', maxWidth: 440, borderRadius: isSettingsMode ? 0 : 3, p: isSettingsMode ? 0 : 4, border: isSettingsMode ? 'none' : undefined, textAlign: 'center' }}
      >
        <MarkEmailReadOutlined sx={{ fontSize: 56, color: 'primary.main', mb: 1.5 }} />
        <Typography variant="h5" fontWeight={800} mb={0.5}>
          Verify your email
        </Typography>
        <Typography variant="body2" color="text.secondary" mb={3}>
          We sent a verification link to{' '}
          <Box component="span" fontWeight={700} color="text.primary">{email}</Box>.
          Click the link in that email, then come back and sign in.
        </Typography>

        {notice && (
          <Alert severity="success" sx={{ mb: 2, borderRadius: 2, textAlign: 'left' }}>
            {notice}
          </Alert>
        )}
        {error && (
          <Alert severity="error" sx={{ mb: 2, borderRadius: 2, textAlign: 'left' }}>
            {error}
          </Alert>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <Button
            variant="contained"
            fullWidth
            onClick={onBackToSignIn}
            sx={{ borderRadius: 2, fontWeight: 700, py: 1.1 }}
          >
            I've verified — Sign In
          </Button>
          <Button
            variant="text"
            fullWidth
            onClick={handleResend}
            disabled={resending}
            startIcon={resending ? <CircularProgress size={14} color="inherit" /> : null}
            sx={{ borderRadius: 2, fontWeight: 600, textTransform: 'none' }}
          >
            {resending ? 'Resending...' : "Didn't get it? Resend email"}
          </Button>
        </Box>
      </Paper>
    </Box>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// AccountView — shown when already signed in (mainly in Settings)
// ─────────────────────────────────────────────────────────────────────────────

const AccountView = ({ onSignOut, isSettingsMode = false }) => {
  const [user, setUser] = useState(getStoredUser());

  useEffect(() => {
    let cancelled = false;
    fetchCurrentUser().then((fresh) => {
      if (cancelled) return;
      if (fresh) setUser(fresh);
      else if (!isLoggedIn()) onSignOut(); // token was rejected
    });
    return () => { cancelled = true; };
  }, [onSignOut]);

  const handleSignOut = () => {
    signOut();
    onSignOut();
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
        elevation={0}
        variant={isSettingsMode ? 'elevation' : 'outlined'}
        sx={{ width: '100%', maxWidth: 440, borderRadius: isSettingsMode ? 0 : 3, p: isSettingsMode ? 0 : 4, border: isSettingsMode ? 'none' : undefined }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
          <Avatar src={user?.picture || undefined} sx={{ width: 52, height: 52, bgcolor: 'primary.main', fontWeight: 700 }}>
            {(user?.name || user?.email || '?').charAt(0).toUpperCase()}
          </Avatar>
          <Box>
            <Typography variant="h6" fontWeight={700} lineHeight={1.2}>
              {user?.name || 'Your account'}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {user?.email}
            </Typography>
          </Box>
        </Box>

        <Box sx={{ display: 'flex', gap: 1, mb: 3, flexWrap: 'wrap' }}>
          <Chip
            size="small"
            icon={<LockOpenOutlined sx={{ fontSize: 14 }} />}
            label="Plugin access unlocked"
            sx={{ bgcolor: '#05966915', color: '#059669', fontWeight: 700, borderRadius: 1.5 }}
          />
          <Chip
            size="small"
            label={`${(user?.plan || 'free').toUpperCase()} plan`}
            sx={{ bgcolor: '#6366f115', color: '#6366f1', fontWeight: 700, borderRadius: 1.5 }}
          />
        </Box>

        <Typography variant="body2" color="text.secondary" mb={3}>
          You're signed in. Locked plugins in the connector library are now available to install and use.
        </Typography>

        <Button
          variant="outlined"
          color="error"
          startIcon={<Logout />}
          onClick={handleSignOut}
          sx={{ borderRadius: 2, fontWeight: 700, textTransform: 'none' }}
        >
          Sign Out
        </Button>
      </Paper>
    </Box>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// BringYourOwnKey — provider selection + key input (unchanged logic)
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
        {[...PROVIDERS, OTHERS_TILE].map((p) => {
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
              Choose Claude, Gemini, ChatGPT, or Others (any OpenAI-compatible provider) and we'll
              show you exactly how to get set up.
            </Typography>
          </Box>
        ) : selectedProvider === 'others' ? (
          <Box sx={{ p: 4, maxWidth: 660 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
              {OTHERS_TILE.logo(false)}
              <Box>
                <Typography variant="h5" fontWeight={700}>{OTHERS_TILE.name}</Typography>
                <Chip
                  size="small"
                  label={OTHERS_TILE.company}
                  sx={{ bgcolor: OTHERS_TILE.bgColor, color: OTHERS_TILE.borderColor, fontWeight: 600, fontSize: 11, mt: 0.5 }}
                />
              </Box>
            </Box>
            <Typography variant="body2" color="text.secondary" mb={3}>
              Connect OpenRouter, Groq, Together AI, Mistral, Ollama, LM Studio, or any
              OpenAI-compatible endpoint. Pick a type to prefill its URL, or choose Custom to set your own.
            </Typography>
            <OthersProviderForm onComplete={onComplete} />
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
                API key saved!
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
  // Full-screen onboarding: step 1 is the required API key ('key'), step 2 is
  // the optional, skippable account ('signin' | 'register' | 'verify').
  // Settings mode shows only the account flow ('account' when signed in).
  const [view, setView] = useState(() =>
    isSettingsMode ? (isLoggedIn() ? 'account' : 'signin') : 'key'
  );
  const [pendingEmail, setPendingEmail] = useState('');

  const handleNeedsVerification = (email) => {
    setPendingEmail(email);
    setView('verify');
  };

  const handleAccountComplete = (payload) => {
    if (isSettingsMode) {
      setView('account');
      onComplete(payload);
    } else {
      onComplete(payload);
    }
  };

  // Onboarding: key saved → offer the optional sign-in step.
  const handleKeySaved = () => setView('signin');

  // Onboarding: the account step can be skipped — the key alone unlocks the app.
  const handleSkip = () => onComplete({ via: 'key' });

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

  const onboardingStep = view === 'key' ? 1 : 2;

  return (
    <Box sx={containerStyles}>
      {/* ── Header (onboarding only — Settings has its own chrome) ── */}
      {!isSettingsMode && (
        <Box sx={headerStyles}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, pb: 2 }}>
            <KeyOutlined sx={{ color: 'primary.main', fontSize: 28 }} />
            <Box>
              <Typography variant="h6" fontWeight={700} lineHeight={1.2}>
                Ternlux — Get Started
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {onboardingStep === 1
                  ? 'Step 1 of 2 — Connect your LLM provider with your own API key'
                  : 'Step 2 of 2 — Sign in for plugin access (optional)'}
              </Typography>
            </Box>
          </Box>
        </Box>
      )}

      {/* ── Body ── */}
      <Box sx={{ flex: 1, display: 'flex', overflow: isSettingsMode ? 'auto' : 'hidden' }}>
        {view === 'key' && (
          <BringYourOwnKey onComplete={handleKeySaved} isSettingsMode={isSettingsMode} />
        )}
        {view === 'account' && (
          <AccountView
            onSignOut={() => setView('signin')}
            isSettingsMode={isSettingsMode}
          />
        )}
        {view === 'signin' && (
          <SignInView
            onRegister={() => setView('register')}
            onComplete={handleAccountComplete}
            onNeedsVerification={handleNeedsVerification}
            onSkip={isSettingsMode ? null : handleSkip}
            isSettingsMode={isSettingsMode}
          />
        )}
        {view === 'register' && (
          <RegisterPage
            onBack={() => setView('signin')}
            onComplete={handleAccountComplete}
            onRegistered={handleNeedsVerification}
            isSettingsMode={isSettingsMode}
          />
        )}
        {view === 'verify' && (
          <VerifyEmailView
            email={pendingEmail}
            onBackToSignIn={() => setView('signin')}
            isSettingsMode={isSettingsMode}
          />
        )}
      </Box>
    </Box>
  );
};

export default ApiKeySetup;
