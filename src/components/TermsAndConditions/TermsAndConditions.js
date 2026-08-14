import React, { useState } from 'react';
import {
  Box,
  Typography,
  Button,
  Paper,
  Checkbox,
  FormControlLabel,
  Divider,
  Alert,
  Switch,
  Card,
  CardContent,
} from '@mui/material';
import {
  GavelOutlined,
  CheckCircle,
  InsightsOutlined,
  ShieldOutlined,
} from '@mui/icons-material';

const STORAGE_KEY_ACCEPTED = 'ternlux_terms_accepted';
const STORAGE_KEY_VERSION = 'ternlux_terms_version';
const STORAGE_KEY_ANALYTICS = 'ternlux_analytics_opt_in';
const TERMS_VERSION = '1.0';



const TermsAndConditions = ({ onComplete }) => {
  const [accepted, setAccepted] = useState(false);
  // Analytics is opt-IN and off by default (matches the Terms copy below and
  // the Privacy settings default). The user must affirmatively enable it.
  const [analyticsOptIn, setAnalyticsOptIn] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleContinue = async () => {
    if (!accepted) {
      setError('You must accept the Terms and Conditions to continue.');
      return;
    }
    setSubmitting(true);
    try {
      const acceptedAt = new Date().toISOString();
      localStorage.setItem(STORAGE_KEY_ACCEPTED, 'true');
      localStorage.setItem(STORAGE_KEY_VERSION, TERMS_VERSION);
      localStorage.setItem(STORAGE_KEY_ANALYTICS, analyticsOptIn ? 'true' : 'false');
      localStorage.setItem('ternlux_terms_accepted_at', acceptedAt);

      try {
        await window.electronAPI?.terms?.save?.({
          accepted: true,
          version: TERMS_VERSION,
          acceptedAt,
          analyticsOptIn,
        });
      } catch (e) {
        console.warn('Could not persist terms acceptance via main:', e);
      }

      try {
        await window.electronAPI?.analytics?.setOptIn(analyticsOptIn);
      } catch (e) {
        console.warn('Could not push analytics opt-in to main:', e);
      }

      onComplete?.({ analyticsOptIn });
    } catch (e) {
      setError('Unable to save your preferences. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <Box
      sx={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        bgcolor: '#f8f9fa',
        zIndex: 9999,
      }}
    >
      {/* Header */}
      <Box
        sx={{
          px: 4,
          pt: 2.5,
          pb: 2,
          borderBottom: '1px solid',
          borderColor: 'divider',
          bgcolor: 'background.paper',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, ml: 8 }}>
          <Box>
            <Typography variant="h6" fontWeight={700} lineHeight={1.2}>
              Ternlux — Terms & Privacy
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Please review and accept before continuing
            </Typography>
          </Box>
        </Box>
      </Box>

      {/* Body */}
      <Box
        sx={{
          flex: 1,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          overflowY: 'auto',
          p: 4,
        }}
      >
        <Paper
          variant="outlined"
          sx={{
            width: '100%',
            maxWidth: 760,
            borderRadius: 3,
            p: { xs: 3, sm: 4 },
          }}
        >
          <Typography variant="h5" fontWeight={800} mb={0.5} textAlign="center">
            Welcome to Ternlux
          </Typography>
          <Typography variant="body2" color="text.secondary" mb={3} textAlign="center">
            Before you get started, take a moment to review our Terms and Conditions
            and choose your analytics preference.
          </Typography>

          {/* Terms scroll area */}
          <Paper
            variant="outlined"
            sx={{
              maxHeight: 320,
              overflowY: 'auto',
              p: 3,
              borderRadius: 2,
              bgcolor: 'grey.50',
              mb: 3,
            }}
          >

<h1>Ternlux — Terms of Service</h1>
<p class="df-meta"><strong>Last updated:</strong> 2026-05-06</p>

<blockquote>
  <p><strong>Plain-language summary.</strong> Ternlux is a desktop application that runs on your computer. Your workflows, your data, your database passwords, and the prompts you send to AI providers stay on your machine and travel directly to the third-party services <em>you</em> choose. We are not in the data path. The only information that ever reaches our servers is (a) anonymous product analytics — and only if you opt in — and (b) requests you make to optional services such as the plugin marketplace. The summary is for convenience; the binding terms are below.</p>
</blockquote>



<h2>1. Acceptance of these Terms</h2>
<p>These Terms of Service (the <strong>"Terms"</strong>) are a binding agreement between you (<strong>"you,"</strong> <strong>"your,"</strong> the <strong>"User"</strong>) and <strong>Ternlux Inc.</strong>, a California corporation (<strong>"Ternlux,"</strong> <strong>"we,"</strong> <strong>"us,"</strong> <strong>"our"</strong>), governing your download, installation, and use of the Ternlux desktop application, any companion services we make available from time to time, and any documentation we provide (collectively, the <strong>"Software"</strong>).</p>
<p>By installing, copying, accessing, or using the Software — or by clicking "I Agree" on the in-app Terms acceptance screen — you confirm that you have read, understood, and agree to be bound by these Terms and by the Ternlux Privacy Policy, which is incorporated by reference. If you do not agree, do not install or use the Software, and remove any copy you have already installed.</p>
<p>You must be of the age of majority in your place of residence and able to form a legally binding contract. If you are using the Software on behalf of an organization, you represent that you have authority to bind that organization, and "you" refers to that organization.</p>



<h2>2. Scope of License</h2>

<h3>2.1 Grant</h3>
<p>Subject to your continuing compliance with these Terms, Ternlux grants you a limited, personal, non-exclusive, non-transferable, non-sublicensable, revocable license to install and run the Software on devices that you own or control, solely for your internal business or personal use of the Software's functionality.</p>
<p>The Software is <strong>licensed, not sold</strong>. All title, ownership rights, and intellectual property rights in and to the Software (including all copies, modifications, and derivative works of any portion thereof) are and will remain the exclusive property of Ternlux and its licensors.</p>

<h3>2.2 Permitted use</h3>
<p>You may:</p>
<ul>
  <li>Install the Software on any number of devices that you alone use, or that are under the control of a single named end user inside your organization, subject to any commercial license terms that may be separately agreed.</li>
  <li>Make a reasonable number of backup copies of the installer.</li>
  <li>Use the Software to build and execute data workflows ("DAGs") against data sources, destinations, and third-party APIs that you are lawfully entitled to access.</li>
</ul>

<h3>2.3 Restrictions</h3>
<p>You shall not, and shall not permit any third party to:</p>
<ol>
  <li>Reverse engineer, decompile, disassemble, or otherwise attempt to derive the source code, underlying ideas, algorithms, file formats, or non-public APIs of the Software, except to the extent that such restriction is expressly prohibited by applicable law and is necessary to develop interoperable software (and then only to that minimum extent).</li>
  <li>Distribute, sublicense, sell, rent, lease, transmit, broadcast, transfer, or otherwise make the Software available to any third party.</li>
  <li>Modify, translate, or create derivative works of the Software, other than user-authored workflows, plugins, and configurations created using the documented extension surfaces.</li>
  <li>Remove, obscure, or alter any proprietary notices, trademarks, license keys, or other identifying marks on or in the Software.</li>
  <li>Use the Software to provide a hosted service to third parties, or to build a competing product.</li>
  <li>Use the Software to infringe any third party's intellectual property, privacy, contractual, or other rights, or to violate any applicable law, regulation, sanctions program, or export-control rule.</li>
  <li>Tamper with, disable, or circumvent any security feature, telemetry opt-out control, or update mechanism of the Software, except by using the documented user controls (e.g., the Settings → Privacy toggle).</li>
</ol>

<h3>2.4 Open-source components</h3>
<p>The Software incorporates open-source software components governed by their own license terms (collectively, the <strong>"OSS Components"</strong>). The applicable OSS license terms control your use of those components and, to the extent of any conflict with these Terms with respect to those components, take precedence. A list of OSS Components and notices is made available with the Software (e.g., in the in-app About screen or distributed <code>THIRD_PARTY_NOTICES</code> file).</p>

<h3>2.5 Plugins</h3>
<p>The Software supports first-party and third-party plugins (the latter distributed via the optional Ternlux Plugin Marketplace, see §7). Third-party plugins are not part of the Software, are not controlled by Ternlux, and are made available solely as a convenience. Use of any third-party plugin is at your sole risk, and any rights and obligations arising from such use are between you and the plugin author.</p>



<h2>3. User Content and Data Sovereignty</h2>

<h3>3.1 You own your content</h3>
<p>As between you and Ternlux, you retain all right, title, and interest in and to:</p>
<ul>
  <li>Workflow definitions, node configurations, scripts, SQL, prompts, and any other content you author in the Software (<strong>"User Content"</strong>);</li>
  <li>Source data, intermediate data, and output data processed through any workflow you build (<strong>"User Data"</strong>); and</li>
  <li>Credentials you enter into the Software, including LLM API keys, database passwords, OAuth tokens, REST-API tokens, and connection strings (<strong>"User Credentials"</strong>).</li>
</ul>
<p>Ternlux claims no ownership interest in User Content, User Data, or User Credentials.</p>

<h3>3.2 Local-first architecture</h3>
<p>The Software is <strong>local-first</strong>. Workflow definitions, execution history, chat sessions, imported tabular data, and credentials are stored on the device on which the Software is installed, under the operating system's standard application-data directory. Without limitation:</p>
<ul>
  <li>User Content and User Data created or processed by the Software are written to the local file system on your device. They are not transmitted to Ternlux infrastructure.</li>
  <li>User Credentials are stored on your device, encrypted at rest where the operating system supports it (see §8).</li>
  <li>When the Software executes a workflow, it connects <strong>directly from your device</strong> to the data sources, destinations, AI providers, and other endpoints you have configured. Data flowing to or from those endpoints does not transit Ternlux infrastructure.</li>
</ul>
<p>The narrowly-scoped exceptions to this rule are: (i) anonymous, opt-in product telemetry (§6), and (ii) optional services you affirmatively activate, such as the Plugin Marketplace (§7) or any Optional Cloud Services (§8 below). All such exceptions are described expressly in these Terms and in the Privacy Policy.</p>

<h3>3.3 No license to your content</h3>
<p>Except as strictly necessary for the Software to perform the operations you direct it to perform on your own device, Ternlux is granted <strong>no license</strong> in or to User Content, User Data, or User Credentials. We do not access, copy, transmit, mine, train models on, or otherwise process your content, except to the extent expressly described in §6 and §7.</p>

<h3>3.4 Your responsibilities for your content</h3>
<p>You represent and warrant that:</p>
<ol>
  <li>You have all rights, consents, and authorizations necessary to process the User Data using the Software, including in connection with any third-party data source, destination, or API you configure.</li>
  <li>Your use of the Software, and the content you process, comply with all applicable laws (including data-protection, export-control, sanctions, and intellectual-property laws) and with the terms of any third-party service you connect to.</li>
  <li>You are solely responsible for the contents of any prompt, query, or payload that you (directly, or via the Software's automation features) submit to a third-party AI provider, database, cloud service, or REST API endpoint.</li>
</ol>

<h3>3.5 Backups</h3>
<p>Because the Software stores your content locally, you are responsible for backing up the application's data directory and for any export or archival of User Content and User Data. Ternlux has no ability to recover your data if it is lost, corrupted, or deleted on your device.</p>



<h2>4. Third-Party Services</h2>

<h3>4.1 What "Third-Party Services" means</h3>
<p>The Software is designed to interoperate with third-party software, APIs, and services that you choose to configure, including without limitation:</p>
<ul>
  <li><strong>AI / LLM providers</strong> — Anthropic, OpenAI, Google AI Studio (Gemini), HuggingFace Inference, and any other provider supported now or in the future;</li>
  <li><strong>Databases</strong> — PostgreSQL, MySQL, Microsoft SQL Server, MongoDB, BigQuery, Snowflake, Amazon Redshift, and similar;</li>
  <li><strong>Cloud storage and SaaS</strong> — Amazon S3, Google Cloud Storage, Azure Blob Storage, Dropbox, Google Drive, Google Sheets, Microsoft OneDrive, SharePoint, Slack, Pinecone, and similar;</li>
  <li><strong>Arbitrary REST API endpoints</strong> — any HTTPS endpoint you configure via the REST API connector; and</li>
  <li><strong>OAuth identity providers</strong> used by any of the above</li>
</ul>
<p>(collectively, <strong>"Third-Party Services"</strong>).</p>

<h3>4.2 Direct-to-vendor calls; not proxied</h3>
<p>Calls to Third-Party Services are made <strong>directly from your device</strong> to the relevant vendor over the public internet. Ternlux does not operate as a proxy, broker, gateway, or man-in-the-middle for these calls, and Ternlux infrastructure is not in the network path. Authentication material, request payloads, and response payloads pass between your device and the third-party endpoint only.</p>

<h3>4.3 Bring Your Own Key (BYOK) — AI providers</h3>
<p>The Software's AI features require you to supply your own API key for the LLM provider you choose. When you invoke an AI feature, your prompt, any chat history you have selected, the model name, and your API key are transmitted from your device <strong>directly to the LLM provider</strong> that issued the key.</p>
<p>You acknowledge and agree that:</p>
<ol>
  <li>Your use of any LLM provider is governed by <strong>the terms and privacy policy you have separately agreed to with that provider</strong>, not by these Terms. Whether and how the provider stores, uses, retains, or trains models on your prompts and outputs is determined entirely by that provider.</li>
  <li>Ternlux is not a party to your relationship with the LLM provider, does not negotiate or pass through any data-processing terms on your behalf, and is not responsible for any provider's act or omission.</li>
  <li>If the provider's terms require certain notices, opt-outs (e.g., from training-data use), or contractual arrangements (e.g., a Zero Data-Retention agreement), it is your responsibility to obtain them directly from the provider.</li>
  <li>Costs and rate limits incurred against your API key are your sole responsibility.</li>
</ol>
<p>The same direct-to-vendor model applies to databases, cloud storage, SaaS, REST API endpoints, and any other Third-Party Service the Software supports. Your use of each such service is governed by your separate agreement with that service's operator.</p>

<h3>4.4 OAuth flows</h3>
<p>For connectors that use OAuth (e.g., Dropbox, Google, Microsoft, Slack), the Software opens your system browser to the provider's authorization URL, runs a temporary loopback HTTP server on your device to receive the redirect, and exchanges the authorization code for tokens by calling the provider's token endpoint <strong>directly from your device</strong>. The resulting tokens are stored locally per §8. Tokens are not transmitted to Ternlux.</p>

<h3>4.5 User-supplied destinations (REST API connector)</h3>
<p>The Software's REST API connector allows you to configure HTTPS calls against <strong>any endpoint you choose</strong>. Ternlux does not maintain an allowlist or denylist of endpoints, does not endorse any endpoint, and does not pre-vet the endpoints you reach. You represent and warrant that you have the right to access each endpoint you configure, and that your use complies with that endpoint's terms and applicable law.</p>

<h3>4.6 No Ternlux endorsement</h3>
<p>Ternlux does not endorse, certify, or guarantee any Third-Party Service. The availability of a connector for a given Third-Party Service is for your convenience only and does not imply any relationship between Ternlux and that service's operator. You assume all risks of using Third-Party Services, including risks of unavailability, data loss, unauthorized disclosure, breach, or change in terms.</p>



<h2>5. Risk of AI-Generated Code</h2>

<h3>5.1 What the Software does</h3>
<p>Certain features of the Software use a Large Language Model — which the Software invokes against the LLM provider you have configured (§4.3) — to generate executable code (including, without limitation, JavaScript "fetch plans" used by the REST API connector and SQL statements used by transformation nodes) that runs <strong>on your device</strong>, in the same operating-system process as the Software, with the privileges of the operating-system user account that launched the Software.</p>
<p>Specifically, AI-generated JavaScript supplied to the REST API connector is compiled and invoked in the privileged main process of the Software and is granted access to an HTTP client capable of issuing arbitrary outbound HTTPS requests, including with credentials substituted from your encrypted credential store.</p>

<h3>5.2 Disclaimer of warranty for AI-generated output</h3>
<p>YOU ACKNOWLEDGE AND AGREE THAT:</p>
<ol>
  <li><strong>AI-generated code is supplied "as is."</strong> Ternlux makes no representation or warranty that any AI-generated JavaScript, SQL, prompt, plan, or other output is accurate, complete, secure, free of defects or vulnerabilities, fit for a particular purpose, non-infringing, or compliant with any applicable standard, law, or third-party term.</li>
  <li><strong>The provider — not Ternlux — authors the output.</strong> Ternlux composes the prompt and parses the response, but the substantive output is produced by the LLM provider you have selected. By choosing to use AI features, you choose to extend trust to that provider's output to the scope described in §5.1.</li>
  <li><strong>The substitution layer is not a sandbox.</strong> The Software escapes credential values for safe embedding inside string literals when it substitutes them into AI-generated source code, but this is a defense-in-depth measure, not an isolation boundary. Code generated by, or influenced by, an attacker-controlled prompt or attacker-controlled source data could perform unintended operations.</li>
  <li><strong>You are the operator.</strong> You are solely responsible for reviewing, testing, and approving any AI-generated code before execution against production data sources or destinations, and for the consequences of running it.</li>
</ol>

<h3>5.3 Prompt injection and hostile input</h3>
<p>You acknowledge that data ingested by the Software (including data returned by REST API endpoints, files, database query results, and chat inputs) may contain instructions intended to subvert AI behavior ("prompt injection"). Ternlux does not warrant that the Software detects, prevents, or neutralizes such input. You are responsible for evaluating the trustworthiness of data sources before exposing their content to AI features.</p>



<h2>6. Telemetry</h2>

<h3>6.1 Default state and your control</h3>
<p>The Software collects anonymous product-usage telemetry <strong>only on an opt-in basis</strong>. The opt-in flag is off by default and is set the first time you make a choice on the in-app Terms acceptance screen. You can change the setting at any time at <strong>Settings → Privacy</strong>.</p>
<p>Until you opt in, the Software emits no telemetry events.</p>

<h3>6.2 What is collected (and only this)</h3>
<p>When telemetry is enabled, each tracked user action causes the Software to send a single HTTPS POST to our analytics ingest endpoint with a JSON payload of the following exact shape:</p>
<pre></pre>
<p>The set of <code>event</code>/<code>channel</code> values that emit telemetry is fixed in the Software's source code (currently: workflow execution, AI calls, connection tests, plugin install/uninstall, OAuth start/exchange, file imports, and skill prompt builds).</p>

<h3>6.3 What is never collected</h3>
<p>Telemetry never includes, and our ingest endpoint affirmatively rejects on a server-side allowlist:</p>
<ul>
  <li>prompts, AI responses, or chat content;</li>
  <li>SQL queries, query results, row data, or column values;</li>
  <li>workflow node configurations beyond high-level counts;</li>
  <li>file names, file contents, file paths, or directory contents;</li>
  <li>API keys, OAuth tokens, database credentials, or any other secret;</li>
  <li>your name, email, IP-derived geolocation tied to identity, or any account identifier; and</li>
  <li>free-form error messages (errors are reduced client-side to a bounded class-name label).</li>
</ul>

<h3>6.4 Identifiers</h3>
<p>The <code>deviceId</code> is a UUID generated locally on first run and is not derived from any input you provide. Reinstalling the Software produces a new <code>deviceId</code>. The <code>sessionId</code> is generated at process start and discarded on exit. Neither identifier is used for cross-product tracking, advertising, or marketing.</p>

<h3>6.5 Server-side handling</h3>
<p>Telemetry is transported over HTTPS to AWS API Gateway and processed by an AWS Lambda function operated by Ternlux, which writes events to a MongoDB database. The source IP address observed by API Gateway is recorded on the event record for abuse mitigation only.</p>

<h3>6.6 Why we collect it</h3>
<p>We use telemetry to understand which features are used, to detect regressions and outages, to prioritize engineering work, and to plan the roadmap. We do not sell telemetry, share it with advertisers, or use it to build a profile of you.</p>



<h2>7. Optional Cloud Services (Forward-Looking)</h2>
<p>The Software is designed to remain useful entirely offline. From time to time, however, Ternlux may make available optional cloud-side features (collectively, <strong>"Optional Cloud Services"</strong>) that you may choose to activate. These currently include, or may in the future include:</p>
<ol>
  <li>The <strong>Ternlux Plugin Marketplace</strong>, which serves a directory of third-party plugins and the binaries thereof over HTTPS. When you browse or install a plugin, the Software contacts our backend with the plugin identifier; standard request metadata (IP address, user-agent) is observed by our servers for service operation and abuse mitigation.</li>
  <li><strong>Account registration and login</strong>, where you may create an account by providing your name, email address, password, and chosen plan.</li>
  <li><strong>Cloud-managed workflows, executions, and chat history</strong>, where workflow definitions, execution records, and assistant chat sessions would be synchronized to or stored on Ternlux infrastructure.</li>
  <li><strong>Managed OAuth and managed AI</strong>, where the Software would route authentication or LLM calls through Ternlux infrastructure rather than direct from your device.</li>
  <li><strong>Software auto-update</strong>, where the Software would periodically contact a Ternlux update server to check for new releases.</li>
</ol>

<h3>7.1 Activation = consent</h3>
<p>Each Optional Cloud Service is governed by these Terms and the Privacy Policy <strong>only from the moment you affirmatively activate it</strong> — for example, by registering an account, by enabling a "sync to cloud" setting, by clicking "Install" on a marketplace plugin, or by accepting an in-app prompt to enable a feature. Until activation, no data flows to Ternlux for that feature.</p>

<h3>7.2 Supplemental terms</h3>
<p>Some Optional Cloud Services may, at activation time, present supplemental terms (for example, an account-services agreement, a Data Processing Addendum, or fee terms). Where presented, those supplemental terms apply in addition to these Terms and, in the event of conflict with these Terms, govern with respect to that service.</p>

<h3>7.3 Deactivation</h3>
<p>You may deactivate any Optional Cloud Service through the in-app controls provided for that service. Deactivation stops further collection and use under that service for prospective use. The handling and deletion of any data already submitted under an Optional Cloud Service is described in the Privacy Policy and in any supplemental terms applicable to that service.</p>

<h3>7.4 Forward-looking nature</h3>
<p>Some Optional Cloud Services described in this Section may not yet be generally available. Ternlux may add, modify, suspend, or discontinue Optional Cloud Services at any time. Nothing in these Terms commits Ternlux to release, maintain, or continue any such service.</p>



<h2>8. Security and Credential Responsibility</h2>

<h3>8.1 What we do</h3>
<p>The Software stores LLM API keys, database passwords, OAuth tokens, and REST-API authentication values on your device using the operating system's <code>safeStorage</code> facility, which delegates to:</p>
<ul>
  <li><strong>macOS</strong> — Keychain</li>
  <li><strong>Windows</strong> — DPAPI / Credential Store</li>
  <li><strong>Linux</strong> — Secret Service (<code>libsecret</code>) where available; on systems where <code>libsecret</code> is unavailable, the underlying platform may store values without OS-level encryption</li>
</ul>
<p>Encryption keys are tied to your operating-system user account and are managed by your operating system. Ternlux does not transmit, escrow, or manage these keys.</p>

<h3>8.2 What we do not do</h3>
<p>Ternlux does not implement application-level encryption of workflow files, execution history, chat history, or imported tabular data. These files are written to the local application-data directory in plaintext and rely on operating-system file permissions and on the security of your device for confidentiality.</p>

<h3>8.3 Your responsibilities</h3>
<p>The security of credentials and data on your device is your responsibility. Without limitation, you are responsible for:</p>
<ol>
  <li>The physical security of the device on which the Software is installed, including device encryption (e.g., FileVault, BitLocker, LUKS);</li>
  <li>The security of your operating-system user account, including its password, screen-lock, and any related authentication;</li>
  <li>Safe management and rotation of API keys, OAuth grants, and database credentials, including revoking them at the issuing vendor when needed;</li>
  <li>Backups of the Software's local data directory; and</li>
  <li>Restricting access to the Software and its data directory to authorized users.</li>
</ol>

<h3>8.4 No guarantee</h3>
<p>Ternlux makes no representation or warranty that the Software, the operating-system facilities it relies on, or any Optional Cloud Service will be free from vulnerabilities, intrusion, unauthorized access, or data loss. You expressly assume the security risks inherent in running software on a general-purpose computing device connected to the internet.</p>



<h2>9. Privacy</h2>
<p>Ternlux's collection and use of information in connection with the Software is described in the <strong>Ternlux Privacy Policy</strong>, which is incorporated into these Terms by reference. By using the Software, you acknowledge that you have read and understood the Privacy Policy.</p>



<h2>10. Disclaimer of Warranties</h2>
<p class="df-legalese">THE SOFTWARE, ANY OPTIONAL CLOUD SERVICES, ANY AI-GENERATED OUTPUT, AND ALL RELATED MATERIALS ARE PROVIDED <strong>"AS IS"</strong> AND <strong>"AS AVAILABLE,"</strong> WITH ALL FAULTS AND WITHOUT WARRANTY OF ANY KIND. TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, TERNLUX, ITS AFFILIATES, AND ITS LICENSORS DISCLAIM ALL WARRANTIES, EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE, INCLUDING WITHOUT LIMITATION ANY IMPLIED WARRANTY OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, QUIET ENJOYMENT, OR THAT THE SOFTWARE WILL BE ERROR-FREE, SECURE, UNINTERRUPTED, OR FREE OF HARMFUL COMPONENTS.</p>
<p class="df-legalese">WITHOUT LIMITATION, TERNLUX DOES NOT WARRANT THAT (i) THE SOFTWARE WILL MEET YOUR REQUIREMENTS, (ii) ANY DATA WILL BE PRESERVED OR FREE FROM LOSS OR CORRUPTION, (iii) ANY THIRD-PARTY SERVICE WILL BE AVAILABLE OR PERFORM AS REPRESENTED, OR (iv) ANY AI-GENERATED CODE OR CONTENT WILL BE ACCURATE, SAFE, OR FIT FOR THE PURPOSE FOR WHICH YOU USE IT (SEE §5).</p>
<p class="df-legalese">SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OF CERTAIN WARRANTIES; TO THAT EXTENT, THE FOREGOING EXCLUSIONS APPLY ONLY TO THE MAXIMUM EXTENT PERMITTED BY LAW.</p>



<h2>11. Limitation of Liability</h2>
<p class="df-legalese">TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT WILL TERNLUX, ITS AFFILIATES, OR ITS LICENSORS BE LIABLE TO YOU OR ANY THIRD PARTY FOR:</p>
<p class="df-legalese">(a) ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, PUNITIVE, OR COVER DAMAGES;</p>
<p class="df-legalese">(b) ANY LOST PROFITS, LOST REVENUE, LOST GOODWILL, LOST OR INACCURATE DATA, BUSINESS INTERRUPTION, OR REPUTATIONAL HARM;</p>
<p class="df-legalese">(c) ANY DAMAGE ARISING FROM OR RELATED TO YOUR USE OF, OR INABILITY TO USE, ANY THIRD-PARTY SERVICE (INCLUDING ANY LLM PROVIDER, DATABASE, CLOUD-STORAGE PROVIDER, OR USER-CONFIGURED REST API ENDPOINT);</p>
<p class="df-legalese">(d) ANY DAMAGE ARISING FROM AI-GENERATED CODE OR CONTENT, INCLUDING CODE EXECUTED ON YOUR DEVICE PURSUANT TO §5;</p>
<p class="df-legalese">(e) ANY UNAUTHORIZED ACCESS TO, OR LOSS OR ALTERATION OF, YOUR DATA OR CREDENTIALS, EXCEPT TO THE EXTENT CAUSED BY TERNLUX'S GROSS NEGLIGENCE OR WILLFUL MISCONDUCT; OR</p>
<p class="df-legalese">(f) ANY MATTER BEYOND TERNLUX'S REASONABLE CONTROL,</p>
<p class="df-legalese">REGARDLESS OF THE THEORY OF LIABILITY (CONTRACT, TORT, STATUTORY, OR OTHERWISE) AND EVEN IF TERNLUX HAS BEEN ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.</p>
<p class="df-legalese">TERNLUX'S AGGREGATE LIABILITY ARISING OUT OF OR RELATED TO THESE TERMS OR THE SOFTWARE WILL NOT EXCEED THE GREATER OF (i) THE FEES YOU ACTUALLY PAID TO TERNLUX FOR THE SOFTWARE IN THE TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM, OR (ii) <strong>USD ONE HUNDRED DOLLARS ($100)</strong>.</p>
<p class="df-legalese">THE PARTIES ACKNOWLEDGE THAT THE LIMITATIONS IN THIS §11 ARE A FUNDAMENTAL BASIS OF THE BARGAIN AND WILL APPLY EVEN IF ANY LIMITED REMEDY FAILS OF ITS ESSENTIAL PURPOSE. SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OR LIMITATION OF CERTAIN DAMAGES; TO THAT EXTENT, THE FOREGOING APPLIES TO THE MAXIMUM EXTENT PERMITTED BY LAW.</p>



<h2>12. Indemnification</h2>
<p>You agree to defend, indemnify, and hold harmless Ternlux, its affiliates, and their respective officers, directors, employees, and agents from and against any claim, demand, loss, liability, damage, or expense (including reasonable attorneys' fees) arising out of or relating to: (a) User Content, User Data, or User Credentials; (b) your use of the Software in breach of these Terms or in violation of applicable law; (c) your use of any Third-Party Service in connection with the Software, including any breach of that service's terms; (d) your use, configuration, or deployment of any AI-generated code, including under §5; or (e) your infringement or alleged infringement of any third party's rights.</p>



<h2>13. Term and Termination</h2>
<p>These Terms remain in effect for as long as you use the Software. You may terminate them at any time by uninstalling and ceasing to use the Software. Ternlux may terminate or suspend your license immediately if you materially breach these Terms.</p>
<p>Upon termination, your license under §2 ends. You must stop using the Software and destroy all copies in your possession or control. Sections that by their nature are intended to survive termination (including §§ 2.3, 3.1, 3.4, 4–6, 8.3, 10–12, and 13–17) survive.</p>



<h2>14. Changes to These Terms</h2>
<p>Ternlux may revise these Terms from time to time, for example to reflect changes to the Software, to launch or modify Optional Cloud Services, or to comply with law. The revised Terms will indicate a new "Last updated" date. If a change is material, Ternlux will provide reasonable notice — for example, by displaying a notice in the Software, by email (if you have an account), or by requiring re-acceptance on the in-app Terms screen.</p>
<p>Your continued use of the Software after the effective date of revised Terms constitutes your acceptance of those revised Terms. If you do not agree, you must stop using the Software.</p>



<h2>15. Export, Sanctions, and Government Use</h2>
<p>You represent and warrant that you are not located in, ordinarily resident in, or organized under the laws of, any jurisdiction subject to comprehensive trade sanctions administered by the U.S. Government, the European Union, the United Kingdom, or any other applicable authority, and that you are not on any list of restricted or denied parties maintained by such authorities. You will not use, export, or re-export the Software in violation of any applicable export-control or sanctions law.</p>
<p>The Software is "commercial computer software" as defined in 48 C.F.R. 2.101. If you are a U.S. Government end user, your use is governed by this Agreement and not by any other Government license terms.</p>



<h2>16. Applicable Law / Dispute Resolution</h2>
<p>These Terms shall be governed by the laws of the State of California. Except for non-payment by you, any dispute arising from or related to these Terms shall be subject to binding arbitration in Irvine, California.</p>



<h2>17. General</h2>
<p><strong>Entire agreement.</strong> These Terms (together with the Privacy Policy and any supplemental terms you accept for an Optional Cloud Service) are the entire agreement between you and Ternlux concerning the Software, and supersede any prior or contemporaneous agreement on the subject.</p>
<p><strong>Severability.</strong> If any provision is held unenforceable, the remaining provisions remain in full force, and the unenforceable provision will be enforced to the maximum extent permitted by law.</p>
<p><strong>No waiver.</strong> A failure to enforce any provision is not a waiver of the right to enforce it later.</p>
<p><strong>Assignment.</strong> You may not assign or transfer these Terms or any rights under them, by operation of law or otherwise, without Ternlux's prior written consent. Ternlux may assign these Terms in connection with a merger, acquisition, reorganization, or sale of substantially all of its assets.</p>
<p><strong>Independent contractors.</strong> The parties are independent contractors; nothing in these Terms creates an agency, partnership, joint venture, or employment relationship.</p>
<p><strong>Force majeure.</strong> Neither party is liable for any delay or failure to perform (other than your payment obligations) caused by events beyond its reasonable control.</p>
<p><strong>Notices.</strong> Notices to Ternlux must be sent by email to <strong>support@ternlux.com</strong>. Notices to you may be given by email, by in-app notification, or by posting on the Ternlux website.</p>
<p><strong>Headings.</strong> Section headings are for convenience only and do not affect interpretation.</p>



<h2>Contact</h2>
<p>Questions about these Terms can be sent to <strong>support@ternlux.com</strong>.</p>

          </Paper>

          {/* Analytics opt-in card */}
          <Card
            variant="outlined"
            sx={{
              borderRadius: 2,
              borderWidth: 2,
              borderColor: analyticsOptIn ? 'primary.main' : 'divider',
              bgcolor: analyticsOptIn ? 'primary.50' : 'background.paper',
              transition: 'all 0.15s ease',
              mb: 3,
            }}
          >
            <CardContent sx={{ p: 2.5, '&:last-child': { pb: 2.5 } }}>
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
                <Box
                  sx={{
                    width: 40,
                    height: 40,
                    borderRadius: 2,
                    bgcolor: analyticsOptIn ? 'primary.main' : 'grey.200',
                    color: analyticsOptIn ? '#fff' : 'text.secondary',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    transition: 'all 0.15s ease',
                  }}
                >
                  <InsightsOutlined sx={{ fontSize: 22 }} />
                </Box>

                <Box sx={{ flex: 1 }}>
                  <Box
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 2,
                      mb: 0.5,
                    }}
                  >
                    <Typography variant="subtitle1" fontWeight={700}>
                      Share anonymous analytics
                    </Typography>
                    <Switch
                      checked={analyticsOptIn}
                      onChange={(e) => setAnalyticsOptIn(e.target.checked)}
                      color="primary"
                    />
                  </Box>
                  <Typography variant="body2" color="text.secondary" lineHeight={1.5}>
                    Help us improve Ternlux by sharing anonymous usage data — feature
                    interactions, performance metrics, and crash reports. We never
                    collect your workflow contents, credentials, or personally
                    identifiable information. You can change this at any time in
                    Settings.
                  </Typography>

                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 1.25 }}>
                    <ShieldOutlined sx={{ fontSize: 14, color: 'text.disabled' }} />
                    <Typography variant="caption" color="text.disabled">
                      Anonymous & aggregated. No workflow data is ever sent.
                    </Typography>
                  </Box>
                </Box>
              </Box>
            </CardContent>
          </Card>

          {error && (
            <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
              {error}
            </Alert>
          )}

          <FormControlLabel
            control={
              <Checkbox
                checked={accepted}
                onChange={(e) => {
                  setAccepted(e.target.checked);
                  if (e.target.checked) setError('');
                }}
                sx={{ mt: -0.5 }}
              />
            }
            label={
              <Typography variant="body2" sx={{mt:1}}>
                I have read and agree to the{' '}
                <Box component="span" sx={{ fontWeight: 700 }}>
                  Terms and Conditions
                </Box>{' '}
                outlined above.
              </Typography>
            }
            sx={{ alignItems: 'flex-start', mb: 2 }}
          />

          <Divider sx={{ mb: 2.5 }} />

          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1.5 }}>
            <Button
              variant="contained"
              onClick={handleContinue}
              disabled={!accepted || submitting}
              startIcon={<CheckCircle />}
              sx={{
                borderRadius: 2,
                fontWeight: 700,
                py: 1.1,
                px: 3,
              }}
            >
              {submitting ? 'Saving...' : 'Accept & Continue'}
            </Button>
          </Box>
        </Paper>
      </Box>
    </Box>
  );
};

export default TermsAndConditions;
