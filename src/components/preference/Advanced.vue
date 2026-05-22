<script setup lang="ts">
/** @fileoverview Advanced preference tab: RPC, extension, clipboard, protocols, engine, log, history, diagnostics. */
import { ref, computed, nextTick, onMounted, h } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { usePlatform } from '@/composables/usePlatform'
import { useI18n } from 'vue-i18n'
import { usePreferenceStore } from '@/stores/preference'
import { usePreferenceForm } from '@/composables/usePreferenceForm'
import { useEngineRestart } from '@/composables/useEngineRestart'
import { useTaskStore } from '@/stores/task'
import { useHistoryStore } from '@/stores/history'
import { useAdvancedActions } from '@/composables/useAdvancedActions'
import { relaunch } from '@tauri-apps/plugin-process'
import { useIpc } from '@/composables/useIpc'
import { appDataDir, appLogDir, join, tempDir } from '@tauri-apps/api/path'
import { LOG_LEVELS } from '@shared/constants'
import {
  generateSecret,
  buildAdvancedForm,
  buildAdvancedSystemConfig,
  transformAdvancedForStore,
  validateAdvancedForm,
  randomRpcPort,
} from '@/composables/useAdvancedPreference'
import {
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NInputGroup,
  NSwitch,
  NSelect,
  NButton,
  NSpace,
  NDivider,
  NIcon,
  NModal,
  NDataTable,
  NEmpty,
  NCollapseTransition,
  useDialog,
} from 'naive-ui'
import { useAppMessage } from '@/composables/useAppMessage'
import { DiceOutline, DownloadOutline, FolderOpenOutline, TrashOutline, CopyOutline } from '@vicons/ionicons5'
import { logger } from '@shared/logger'
import PreferenceActionBar from './PreferenceActionBar.vue'
import PreferenceCheckboxGrid from './PreferenceCheckboxGrid.vue'

const { restartEngine } = useEngineRestart()

const { t } = useI18n()
const preferenceStore = usePreferenceStore()
const taskStore = useTaskStore()
const historyStore = useHistoryStore()
const message = useAppMessage()
const dialog = useDialog()

const { isLinux } = usePlatform()

import { ENGINE_RPC_PORT } from '@shared/constants'
import { diffConfig, checkIsNeedRestart } from '@shared/utils/config'

const logLevelOptions = LOG_LEVELS.map((l: string) => ({ label: l, value: l }))

type ClipboardType = 'http' | 'ftp' | 'magnet' | 'ed2k' | 'thunder' | 'btHash'
const clipboardTypes: ClipboardType[] = ['http', 'ftp', 'magnet', 'ed2k', 'thunder', 'btHash']
const clipboardTypeOptions = computed(() => [
  { label: t('preferences.clipboard-http'), value: 'http' },
  { label: t('preferences.clipboard-ftp'), value: 'ftp' },
  { label: t('preferences.clipboard-magnet'), value: 'magnet' },
  { label: t('preferences.clipboard-ed2k'), value: 'ed2k' },
  { label: t('preferences.clipboard-thunder'), value: 'thunder' },
  { label: t('preferences.clipboard-bt-hash'), value: 'btHash' },
])
const clipboardFieldByType: Record<ClipboardType, keyof typeof form.value> = {
  http: 'clipboardHttp',
  ftp: 'clipboardFtp',
  magnet: 'clipboardMagnet',
  ed2k: 'clipboardEd2k',
  thunder: 'clipboardThunder',
  btHash: 'clipboardBtHash',
}
const selectedClipboardTypes = computed<string[]>({
  get: () => clipboardTypes.filter((type) => !!form.value[clipboardFieldByType[type]]),
  set: (types) => {
    const selected = new Set(types)
    for (const type of clipboardTypes) {
      form.value[clipboardFieldByType[type]] = selected.has(type)
    }
  },
})

const MANUAL_PROTOCOL_CHANGE_REQUIRED = 'manual_change_required'

const aria2ConfPath = ref('')
const sessionPath = ref('')
const logPath = ref('')
const defaultTempPath = ref('')

const { form, isDirty, handleSave, handleReset, resetSnapshot } = usePreferenceForm({
  buildForm,
  buildSystemConfig: buildAdvancedSystemConfig,
  transformForStore: transformAdvancedForStore,
  beforeSave: async (f) => {
    const error = validateAdvancedForm(f)
    if (error) {
      message.error(t(error))
      return false
    }
    // Only warn when user actively clears the secret (non-empty → empty).
    // If it was already empty before this edit session, no need to re-warn.
    const prevSecret = preferenceStore.config.rpcSecret
    if (!f.rpcSecret && !!prevSecret) {
      const ok = await new Promise<boolean>((resolve) => {
        dialog.warning({
          title: t('preferences.rpc-secret-empty-title'),
          content: t('preferences.rpc-secret-empty-confirm'),
          positiveText: t('preferences.rpc-secret-empty-continue'),
          negativeText: t('app.cancel'),
          maskClosable: false,
          onPositiveClick: () => resolve(true),
          onNegativeClick: () => resolve(false),
          onClose: () => resolve(false),
        })
      })
      if (!ok) return false
    }

    // Gate: engine restart confirmation (RPC port / secret change).
    // Must confirm BEFORE saving — declining cancels the entire save so
    // config.json never contains values the running engine doesn't match.
    const changed = diffConfig(preferenceStore.config, f)
    if (checkIsNeedRestart(changed)) {
      const ok = await new Promise<boolean>((resolve) => {
        dialog.warning({
          title: t('preferences.engine-restart-title'),
          content: t('preferences.engine-restart-confirm'),
          positiveText: t('preferences.engine-restart-now'),
          negativeText: t('app.cancel'),
          maskClosable: false,
          onPositiveClick: () => resolve(true),
          onNegativeClick: () => resolve(false),
          onClose: () => resolve(false),
        })
      })
      if (!ok) return false
    }

    // Gate: extension API port change confirmation.
    // Separate from engine restart — this only rebinds the HTTP API server,
    // downloads are unaffected.
    if (changed.extensionApiPort !== undefined) {
      const ok = await new Promise<boolean>((resolve) => {
        dialog.warning({
          title: t('preferences.extension-api-port'),
          content: t('preferences.extension-api-port-confirm', { port: f.extensionApiPort }),
          positiveText: t('app.confirm'),
          negativeText: t('app.cancel'),
          maskClosable: false,
          onPositiveClick: () => resolve(true),
          onNegativeClick: () => resolve(false),
          onClose: () => resolve(false),
        })
      })
      if (!ok) return false
    }

    // Protocol disable confirmation — single merged dialog.
    const prev = preferenceStore.config.protocols
    const disabledLinks: string[] = []
    if (prev.magnet && !f.protocolMagnet) disabledLinks.push('magnet')
    if (prev.ed2k && !f.protocolEd2k) disabledLinks.push('ed2k')
    if (prev.thunder && !f.protocolThunder) disabledLinks.push('thunder')
    const disabledExt = prev.motrixnext && !f.protocolMotrixnext

    if (disabledLinks.length > 0 || disabledExt) {
      const items: ReturnType<typeof h>[] = []
      for (const p of disabledLinks) {
        items.push(h('div', `• ${t('preferences.protocol-disable-link-warning', { protocols: `${p}://` })}`))
      }
      if (disabledExt) {
        items.push(h('div', `• ${t('preferences.protocol-disable-ext-warning')}`))
      }
      const content =
        items.length > 1
          ? () =>
              h('div', { style: 'display: flex; flex-direction: column; gap: 8px' }, [
                h('div', t('preferences.protocol-disable-intro')),
                ...items,
              ])
          : () => h('div', items)
      const ok = await new Promise<boolean>((resolve) => {
        dialog.warning({
          title: t('preferences.protocol-disable-title'),
          content,
          positiveText: t('preferences.protocol-disable-confirm'),
          negativeText: t('app.cancel'),
          onPositiveClick: () => resolve(true),
          onNegativeClick: () => resolve(false),
          onClose: () => resolve(false),
        })
      })
      if (!ok) return false
    }

    return true
  },
  afterSave: async (f, prevConfig) => {
    const changed = diffConfig(prevConfig, f)

    // Engine restart — user already confirmed in beforeSave, execute immediately.
    if (checkIsNeedRestart(changed)) {
      const port = f.rpcListenPort || ENGINE_RPC_PORT
      const secret = f.rpcSecret || ''
      message.info(t('preferences.engine-restarting'))
      await nextTick()
      await new Promise((r) => requestAnimationFrame(r))
      await restartEngine({ port, secret })
    }

    // Log level changes need a full app relaunch (not engine restart),
    // because tauri-plugin-log is configured at process startup.
    if (changed.logLevel !== undefined && changed.logLevel !== prevConfig.logLevel) {
      dialog.info({
        title: t('preferences.restart-required'),
        content: t('preferences.log-level-restart-confirm'),
        positiveText: t('preferences.restart-now'),
        negativeText: t('preferences.engine-restart-later'),
        maskClosable: false,
        onPositiveClick: async () => {
          const { stopEngine } = useIpc()
          await stopEngine()
          await relaunch()
        },
      })
    }

    // Hardware rendering toggle needs a full app relaunch — the env var
    // WEBKIT_DISABLE_DMABUF_RENDERER is read by WebKitGTK at process startup.
    if (changed.hardwareRendering !== undefined && changed.hardwareRendering !== prevConfig.hardwareRendering) {
      dialog.info({
        title: t('preferences.restart-required'),
        content: t('preferences.hardware-rendering-restart-confirm'),
        positiveText: t('preferences.restart-now'),
        negativeText: t('preferences.engine-restart-later'),
        maskClosable: false,
        onPositiveClick: async () => {
          const { stopEngine } = useIpc()
          await stopEngine()
          await relaunch()
        },
      })
    }

    // Extension API port — user already confirmed in beforeSave, execute immediately.
    if (changed.extensionApiPort !== undefined) {
      const newPort = f.extensionApiPort
      try {
        const appliedPort = await invoke<number>('restart_http_api', { port: newPort })
        if (appliedPort !== newPort) {
          f.extensionApiPort = appliedPort
          preferenceStore.updatePreference({ extensionApiPort: appliedPort })
          resetSnapshot()
        }
        message.success(t('preferences.extension-api-port-applied', { port: appliedPort }))
      } catch (e) {
        logger.warn('Advanced.extensionApi', `restart_http_api port=${newPort} failed: ${e}`)
      }
    }

    // Protocol handler registration (reconcile-based).
    {
      const prevProtocols = prevConfig.protocols ?? { magnet: false, ed2k: false, thunder: false, motrixnext: true }
      for (const [protocol, formKey, prev] of [
        ['magnet', 'protocolMagnet', prevProtocols.magnet],
        ['ed2k', 'protocolEd2k', prevProtocols.ed2k],
        ['thunder', 'protocolThunder', prevProtocols.thunder],
        ['motrixnext', 'protocolMotrixnext', prevProtocols.motrixnext],
      ] as const) {
        const enabled = f[formKey] as boolean
        try {
          if (enabled) {
            const isDefault = await invoke<boolean>('is_default_protocol_client', { protocol })
            if (!isDefault) {
              await invoke('set_default_protocol_client', { protocol })
              message.success(t('preferences.protocol-registered', { protocol }))
            }
          } else if (prev) {
            await invoke('remove_as_default_protocol_client', { protocol })
            message.success(t('preferences.protocol-unregistered', { protocol }))
          }
        } catch (e) {
          const reason =
            e instanceof Error
              ? e.message
              : typeof e === 'object' && e !== null
                ? Object.values(e as Record<string, unknown>).join(': ')
                : String(e)
          logger.warn('Advanced.protocol', `Failed to ${enabled ? 'register' : 'unregister'} ${protocol}: ${reason}`)
          if (!enabled && reason.includes(MANUAL_PROTOCOL_CHANGE_REQUIRED)) {
            message.warning(t('preferences.protocol-unregister-manual-required'))
          } else {
            message.error(t('preferences.protocol-failed', { protocol, reason }))
          }
          ;(f as Record<string, unknown>)[formKey] = prev
          resetSnapshot()
          const revertedProtocols = { ...preferenceStore.config.protocols, [protocol]: prev }
          preferenceStore.updateAndSave({ protocols: revertedProtocols })
        }
      }
    }
  },
})

function buildForm() {
  const c = preferenceStore.config
  const { form: formData, generatedSecret, generatedApiSecret } = buildAdvancedForm(c)
  if (generatedSecret) {
    preferenceStore.updateAndSave({ rpcSecret: generatedSecret })
  }
  if (generatedApiSecret) {
    preferenceStore.updateAndSave({ extensionApiSecret: generatedApiSecret })
  }
  return formData
}

function loadForm() {
  Object.assign(form.value, buildForm())
}

async function loadPaths() {
  try {
    aria2ConfPath.value = await invoke<string>('get_engine_conf_path')
  } catch (e) {
    aria2ConfPath.value = ''
    logger.debug('Advanced.loadConf', e)
  }
  try {
    const dataDir = await appDataDir()
    sessionPath.value = await join(dataDir, 'download.session')
  } catch (e) {
    logger.debug('Advanced.loadPaths', e)
  }
  try {
    const logDir = await appLogDir()
    logPath.value = await join(logDir, 'motrix-next.log')
  } catch (e) {
    logger.debug('Advanced.loadLogPath', e)
  }
  try {
    defaultTempPath.value = await tempDir()
  } catch (e) {
    logger.debug('Advanced.loadTempPath', e)
  }
}

function onRpcPortDice() {
  form.value.rpcListenPort = randomRpcPort()
}

function onRpcSecretDice() {
  form.value.rpcSecret = generateSecret()
}

function onApiSecretDice() {
  form.value.extensionApiSecret = generateSecret()
}

async function copyToClipboard(text: string, label: string) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    message.success(t('preferences.copied-to-clipboard', { label }))
  } catch (e) {
    logger.debug('Advanced.clipboard', `writeText failed: ${e}`)
  }
}

async function handleSelectTempDir() {
  const selected = await openDialog({ directory: true, multiple: false })
  if (typeof selected === 'string') form.value.tempFilesDir = selected
}

function handleClearTempDir() {
  form.value.tempFilesDir = ''
}

// ─── Advanced Actions (delegated to composable) ─────────────────────

const {
  showDbBrowse,
  dbRecords,
  dbRecordsLoading,
  dbBrowseColumns,
  exportingLogs,
  handleManualRestart: handleManualRestartAction,
  handleSessionReset,
  handleRestoreDefaults,
  handleFactoryReset,
  handleDbIntegrityCheck,
  handleDbBrowse,
  handleDbReset,
  handleExportLogs,
  handleClearLog,
  handleRevealPath,
  handleOpenConfigFolder,
} = useAdvancedActions({
  t,
  message,
  taskStore,
  historyStore,
  preferenceStore,
  form,
  buildForm,
  resetSnapshot,
})

function handleManualRestart() {
  handleManualRestartAction(form.value.rpcListenPort as number, form.value.rpcSecret as string)
}

onMounted(async () => {
  loadForm()
  resetSnapshot()
  loadPaths()

  // Read actual OS registration state for protocol toggles (all platforms).
  // Uses custom Rust commands that support macOS NSWorkspace + Windows/Linux deep-link.
  // This ensures the switches reflect reality even if another app has taken
  // over the protocol association since Motrix last ran.
  try {
    form.value.protocolMagnet = await invoke<boolean>('is_default_protocol_client', { protocol: 'magnet' })
    form.value.protocolEd2k = await invoke<boolean>('is_default_protocol_client', { protocol: 'ed2k' })
    form.value.protocolThunder = await invoke<boolean>('is_default_protocol_client', { protocol: 'thunder' })
    form.value.protocolMotrixnext = await invoke<boolean>('is_default_protocol_client', { protocol: 'motrixnext' })
    // Patch snapshot so OS-queried values don't falsely trigger dirty state.
    resetSnapshot()
  } catch (e) {
    logger.debug('Advanced.protocolCheck', e)
  }
})
</script>

<template>
  <div class="preference-form-wrapper">
    <NForm label-placement="left" label-align="left" label-width="260px" size="small" class="form-preference">
      <NDivider title-placement="left">{{ t('preferences.extension-section') }}</NDivider>
      <NFormItem :label="t('preferences.auto-submit-from-extension')">
        <NSwitch v-model:value="form.autoSubmitFromExtension" />
      </NFormItem>
      <NCollapseTransition :show="form.autoSubmitFromExtension" class="collapse-indent">
        <NFormItem :label="t('preferences.silent-auto-submit-from-extension')">
          <NSwitch v-model:value="form.silentAutoSubmitFromExtension" />
        </NFormItem>
        <NFormItem class="hinted-form-item">
          <template #label>
            <div class="form-label-with-hint">
              <div>{{ t('preferences.auto-select-all-files-from-extension') }}</div>
              <div class="info-text">{{ t('preferences.auto-select-all-files-from-extension-hint') }}</div>
            </div>
          </template>
          <NSwitch v-model:value="form.autoSelectAllFilesFromExtension" />
        </NFormItem>
      </NCollapseTransition>
      <NFormItem :label="t('preferences.extension-api-port')">
        <NInputNumber v-model:value="form.extensionApiPort" :min="1024" :max="65535" style="width: 160px" />
      </NFormItem>
      <NFormItem
        :label="t('preferences.extension-api-secret')"
        :validation-status="form.extensionApiSecret ? undefined : 'warning'"
      >
        <NInputGroup>
          <NInput
            v-model:value="form.extensionApiSecret"
            type="password"
            show-password-on="click"
            :placeholder="t('preferences.extension-api-secret')"
            style="flex: 1"
            :status="form.extensionApiSecret ? undefined : 'warning'"
          />
          <NButton
            style="padding: 0 10px"
            @click="copyToClipboard(form.extensionApiSecret, t('preferences.extension-api-secret'))"
          >
            <template #icon>
              <NIcon :size="14"><CopyOutline /></NIcon>
            </template>
          </NButton>
          <NButton style="padding: 0 10px" @click="onApiSecretDice">
            <template #icon>
              <NIcon :size="14"><DiceOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :show-label="false">
        <div class="info-text">{{ t('preferences.extension-api-secret-tip') }}</div>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.rpc') }}</NDivider>
      <NFormItem :label="t('preferences.rpc-listen-port')">
        <NInputGroup>
          <NInputNumber v-model:value="form.rpcListenPort" :min="1024" :max="65535" style="width: 160px" />
          <NButton
            style="padding: 0 10px"
            @click="copyToClipboard(String(form.rpcListenPort), t('preferences.rpc-listen-port'))"
          >
            <template #icon>
              <NIcon :size="14"><CopyOutline /></NIcon>
            </template>
          </NButton>
          <NButton style="padding: 0 10px" @click="onRpcPortDice">
            <template #icon>
              <NIcon :size="14"><DiceOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.rpc-secret')" :validation-status="form.rpcSecret ? undefined : 'warning'">
        <NInputGroup>
          <NInput
            v-model:value="form.rpcSecret"
            type="password"
            show-password-on="click"
            :placeholder="t('preferences.rpc-secret')"
            style="flex: 1"
            :status="form.rpcSecret ? undefined : 'warning'"
          />
          <NButton style="padding: 0 10px" @click="copyToClipboard(form.rpcSecret, t('preferences.rpc-secret'))">
            <template #icon>
              <NIcon :size="14"><CopyOutline /></NIcon>
            </template>
          </NButton>
          <NButton style="padding: 0 10px" @click="onRpcSecretDice">
            <template #icon>
              <NIcon :size="14"><DiceOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.engine-section') }}</NDivider>
      <NFormItem :label="t('preferences.temp-files-dir')">
        <NInputGroup>
          <NInput
            :value="form.tempFilesDir || defaultTempPath"
            readonly
            style="flex: 1"
            :placeholder="defaultTempPath"
          />
          <NButton
            style="padding: 0 10px"
            @click="copyToClipboard(form.tempFilesDir || defaultTempPath, t('preferences.temp-files-dir'))"
          >
            <template #icon>
              <NIcon :size="14"><CopyOutline /></NIcon>
            </template>
          </NButton>
          <NButton style="padding: 0 10px" @click="handleSelectTempDir">
            <template #icon>
              <NIcon :size="14"><FolderOpenOutline /></NIcon>
            </template>
          </NButton>
          <NButton v-if="form.tempFilesDir" quaternary style="padding: 0 10px" @click="handleClearTempDir">
            {{ t('preferences.ua-reset') }}
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.aria2-conf-path')">
        <NInputGroup>
          <NInput :value="aria2ConfPath" readonly style="flex: 1" />
          <NButton style="padding: 0 10px" @click="copyToClipboard(aria2ConfPath, t('preferences.aria2-conf-path'))">
            <template #icon>
              <NIcon :size="14"><CopyOutline /></NIcon>
            </template>
          </NButton>
          <NButton style="padding: 0 10px" @click="handleRevealPath(aria2ConfPath)">
            <template #icon>
              <NIcon :size="14"><FolderOpenOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.session-path')">
        <NInputGroup>
          <NInput :value="sessionPath" readonly style="flex: 1" />
          <NButton style="padding: 0 10px" @click="copyToClipboard(sessionPath, t('preferences.session-path'))">
            <template #icon>
              <NIcon :size="14"><CopyOutline /></NIcon>
            </template>
          </NButton>
          <NButton style="padding: 0 10px" @click="handleRevealPath(sessionPath)">
            <template #icon>
              <NIcon :size="14"><FolderOpenOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :show-label="false">
        <NButton class="ghost-btn--warning" ghost @click="handleSessionReset">
          {{ t('preferences.clear-all-tasks') }}
        </NButton>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.log-section') }}</NDivider>
      <NFormItem :label="t('preferences.log-path')">
        <NInputGroup>
          <NInput :value="logPath" readonly style="flex: 1" />
          <NButton style="padding: 0 10px" @click="copyToClipboard(logPath, t('preferences.log-path'))">
            <template #icon>
              <NIcon :size="14"><CopyOutline /></NIcon>
            </template>
          </NButton>
          <NButton style="padding: 0 10px" @click="handleRevealPath(logPath)">
            <template #icon>
              <NIcon :size="14"><FolderOpenOutline /></NIcon>
            </template>
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem :label="t('preferences.log-level')">
        <div class="log-level-row">
          <NSelect v-model:value="form.logLevel" :options="logLevelOptions" style="width: 110px" />
          <NButton class="ghost-btn--primary" ghost :loading="exportingLogs" @click="handleExportLogs">
            <template #icon>
              <NIcon><DownloadOutline /></NIcon>
            </template>
            {{ t('preferences.export-diagnostic-logs') }}
          </NButton>
          <NButton class="ghost-btn--danger" ghost @click="handleClearLog">
            <template #icon>
              <NIcon><TrashOutline /></NIcon>
            </template>
            {{ t('preferences.clear-log') }}
          </NButton>
        </div>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.history-section') }}</NDivider>
      <NFormItem :show-label="false">
        <NSpace>
          <NButton class="db-integrity-check-btn" @click="handleDbIntegrityCheck">
            {{ t('preferences.db-integrity-check') }}
          </NButton>
          <NButton class="db-browse-btn" @click="handleDbBrowse">
            {{ t('preferences.db-browse') }}
          </NButton>
          <NButton class="ghost-btn--danger" ghost @click="handleDbReset">
            {{ t('preferences.db-reset') }}
          </NButton>
        </NSpace>
      </NFormItem>

      <NDivider title-placement="left">{{ t('preferences.diagnostics-section') }}</NDivider>
      <NFormItem v-if="isLinux" :label="t('preferences.hardware-rendering')">
        <NSwitch v-model:value="form.hardwareRendering" />
      </NFormItem>
      <NFormItem v-if="isLinux" :show-label="false">
        <div class="info-text">{{ t('preferences.hardware-rendering-hint') }}</div>
      </NFormItem>
      <NFormItem :show-label="false">
        <NSpace>
          <NButton class="open-config-folder-btn" @click="handleOpenConfigFolder">
            <template #icon>
              <NIcon :size="14"><FolderOpenOutline /></NIcon>
            </template>
            {{ t('preferences.open-config-folder') }}
          </NButton>
          <NButton class="ghost-btn--warning" ghost @click="handleRestoreDefaults">
            {{ t('preferences.restore-defaults') }}
          </NButton>
          <NButton class="ghost-btn--danger" ghost @click="handleFactoryReset">
            {{ t('preferences.factory-reset') }}
          </NButton>
        </NSpace>
      </NFormItem>

      <!-- Clipboard Detection (migrated from Basic) -->
      <NDivider title-placement="left">{{ t('preferences.clipboard-detection') }}</NDivider>
      <NFormItem :label="t('preferences.clipboard-auto-detect')">
        <NSwitch v-model:value="form.clipboardEnable" />
      </NFormItem>
      <NCollapseTransition :show="form.clipboardEnable">
        <NFormItem label=" ">
          <PreferenceCheckboxGrid v-model:value="selectedClipboardTypes" :options="clipboardTypeOptions" />
        </NFormItem>
      </NCollapseTransition>

      <!-- Default Programs (migrated from Basic) -->
      <NDivider title-placement="left">{{ t('preferences.default-programs') }}</NDivider>
      <NFormItem :label="t('preferences.protocol-magnet')">
        <NSwitch v-model:value="form.protocolMagnet" />
      </NFormItem>
      <NFormItem :label="t('preferences.protocol-ed2k')">
        <NSwitch v-model:value="form.protocolEd2k" />
      </NFormItem>
      <NFormItem :label="t('preferences.protocol-thunder')">
        <NSwitch v-model:value="form.protocolThunder" />
      </NFormItem>
      <NFormItem :label="t('preferences.protocol-motrixnext')">
        <NSwitch v-model:value="form.protocolMotrixnext" />
      </NFormItem>
    </NForm>

    <!-- Database records viewer modal -->
    <NModal
      v-model:show="showDbBrowse"
      preset="card"
      :title="t('preferences.db-browse-title')"
      style="width: 800px; max-width: 90vw"
      :mask-closable="true"
    >
      <NDataTable
        :columns="dbBrowseColumns"
        :data="dbRecords"
        :loading="dbRecordsLoading"
        :max-height="400"
        :scroll-x="700"
        size="small"
        striped
      >
        <template #empty>
          <NEmpty :description="t('preferences.db-record-count', { count: 0 })" />
        </template>
      </NDataTable>
      <div v-if="dbRecords.length > 0" style="margin-top: 12px; text-align: right; opacity: 0.6; font-size: 13px">
        {{ t('preferences.db-record-count', { count: dbRecords.length }) }}
      </div>
    </NModal>
    <PreferenceActionBar :is-dirty="isDirty" @save="handleSave" @discard="handleReset" @restart="handleManualRestart" />
  </div>
</template>

<style scoped>
.preference-form-wrapper {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.form-preference {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 16px 30px 64px 36px;
}
.form-preference :deep(.n-form-item) {
  padding-left: 50px;
}
.info-text {
  color: var(--m3-on-surface-variant);
  font-size: 12px;
  max-width: 520px;
  word-wrap: break-word;
}
.form-label-with-hint {
  display: flex;
  flex-direction: column;
  gap: 4px;
  line-height: 1.35;
}
.form-preference :deep(.hinted-form-item) {
  margin-bottom: 18px;
}
.form-preference :deep(.collapse-indent) {
  position: relative;
  margin-left: 16px;
}
.info-link {
  color: var(--color-primary);
  text-decoration: none;
  font-size: 12px;
}
.info-link:hover {
  text-decoration: underline;
}
.action-link {
  color: var(--color-primary);
  cursor: pointer;
  margin-left: 8px;
  font-size: 12px;
}
.action-link:hover {
  text-decoration: underline;
}
.form-actions {
  padding: 16px 24px 16px 40px;
}

/* ── Ghost button variants — shared tinted styles with M3 easing ──── */
.ghost-btn--danger {
  --btn-tint: var(--m3-error, #c97070);
  color: var(--btn-tint) !important;
  border-color: var(--btn-tint) !important;
  transition:
    color 0.35s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.35s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ghost-btn--danger:hover {
  background-color: color-mix(in srgb, var(--btn-tint) 12%, transparent) !important;
}
.ghost-btn--danger :deep(.n-button__border),
.ghost-btn--danger :deep(.n-button__state-border) {
  border-color: var(--btn-tint) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}

.ghost-btn--warning {
  --btn-tint: var(--m3-tertiary, #c9a055);
  color: var(--btn-tint) !important;
  border-color: var(--btn-tint) !important;
  transition:
    color 0.35s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.35s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ghost-btn--warning:hover {
  background-color: color-mix(in srgb, var(--btn-tint) 12%, transparent) !important;
}
.ghost-btn--warning :deep(.n-button__border),
.ghost-btn--warning :deep(.n-button__state-border) {
  border-color: var(--btn-tint) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}

.ghost-btn--primary {
  --btn-tint: var(--color-primary, #5b93d5);
  color: var(--btn-tint) !important;
  border-color: var(--btn-tint) !important;
  transition:
    color 0.35s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.35s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ghost-btn--primary:hover {
  background-color: color-mix(in srgb, var(--btn-tint) 12%, transparent) !important;
}
.ghost-btn--primary :deep(.n-button__border),
.ghost-btn--primary :deep(.n-button__state-border) {
  border-color: var(--btn-tint) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}

/* ── Log-level row — select + export button inline ───────────────── */
.log-level-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
}

/* ── UA preset row — button group + standalone reset ─────────────── */
.ua-preset-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

/* ── UA field wrapper — stacks textarea + warning within same NFormItem ── */
.ua-field-wrapper {
  display: flex;
  flex-direction: column;
  width: 100%;
}

/* ── UA warning — CSS Grid 0fr→1fr slide-in, matches proxy-collapse ── */
.ua-warn-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ua-warn-collapse--open {
  grid-template-rows: 1fr;
}
.ua-warn-collapse__inner {
  overflow: hidden;
}
.ua-warn-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  margin-top: 6px;
  border-radius: var(--border-radius);
  background: var(--m3-error-container-bg);
  opacity: 0;
  transition: opacity 0.25s cubic-bezier(0.2, 0, 0, 1);
}
.ua-warn-collapse--open .ua-warn-bar {
  opacity: 1;
}
.ua-warn-text {
  font-size: var(--font-size-sm);
  color: var(--m3-error);
  flex: 1;
}

/* ── UA Reset — muted-rose ghost that highlights on hover ─────────── */
.ua-reset-btn {
  --btn-muted: #c97070;
  color: var(--btn-muted) !important;
  transition:
    color 0.35s cubic-bezier(0.2, 0, 0, 1),
    background-color 0.35s cubic-bezier(0.2, 0, 0, 1),
    border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ua-reset-btn:hover {
  background-color: color-mix(in srgb, var(--btn-muted) 12%, transparent) !important;
}
.ua-reset-btn :deep(.n-button__border) {
  border-color: var(--btn-muted) !important;
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.ua-reset-btn:hover :deep(.n-button__border) {
  border-color: var(--btn-muted) !important;
}
.ua-reset-btn :deep(.n-button__state-border) {
  transition: border-color 0.35s cubic-bezier(0.2, 0, 0, 1);
}

/* ── Proxy collapse — CSS Grid 0fr→1fr for glitch-free height:auto ── */
.proxy-collapse {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.35s cubic-bezier(0.2, 0, 0, 1);
}
.proxy-collapse--open {
  grid-template-rows: 1fr;
}
.proxy-collapse__inner {
  overflow: hidden;
}

/* ── Collapse indent: subordinate toggle hierarchy ────────────────── */
.form-preference :deep(.collapse-indent) {
  margin-left: 16px;
}
</style>
