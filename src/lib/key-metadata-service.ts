import { prisma } from './db';
import { getAdapter } from './adapters/registry';
import type { AdapterContext, KeyMetadataResult, UpstreamAdapter } from './adapters/base';
import { tryDecrypt } from './crypto';
import { getCollectConfig } from './settings';
import { mergeKeyMetadata } from './key-metadata';
import type { Upstream, UpstreamKey, UpstreamType } from '@prisma/client';
import { validateUpstreamBaseUrl } from './outbound';
import { safeStoredError } from './safe-error';

export type MetadataKeyRecord = UpstreamKey & {
  upstream: Pick<Upstream, 'baseUrl' | 'type' | 'testModel'>;
};

export interface KeyMetadataServiceDependencies {
  findKey: (keyId: number) => Promise<MetadataKeyRecord | null>;
  updateKey: (keyId: number, data: Record<string, unknown>) => Promise<UpstreamKey>;
  decrypt: (value: string) => string | null;
  getConfig: () => Promise<{ timeoutMs: number; testModel: string }>;
  getAdapter: (type: UpstreamType) => UpstreamAdapter;
  now: () => Date;
}

export function createKeyMetadataService(deps: KeyMetadataServiceDependencies) {
  return {
    async refresh(keyId: number) {
      const key = await deps.findKey(keyId);
      if (!key) throw new Error('Key 不存在');

      if (key.upstream.type !== 'NEW_API') {
        return {
          key,
          result: { ok: false, errorMessage: '仅支持 NEW_API 上游的元数据刷新' } satisfies KeyMetadataResult,
        };
      }

      try {
        validateUpstreamBaseUrl(key.upstream.type, key.upstream.baseUrl);
      } catch (error) {
        const result: KeyMetadataResult = {
          ok: false,
          errorMessage: safeStoredError(error),
        };
        const updated = await deps.updateKey(key.id, { metadataError: result.errorMessage });
        return { key: updated, result };
      }

      const apiKey = key.apiKeyEnc ? deps.decrypt(key.apiKeyEnc) : null;
      const accessToken = key.accessTokenEnc ? deps.decrypt(key.accessTokenEnc) : null;
      if (!apiKey) {
        const result: KeyMetadataResult = { ok: false, errorMessage: '未配置有效 API Key' };
        const updated = await deps.updateKey(key.id, { metadataError: result.errorMessage });
        return { key: updated, result };
      }

      const adapter = deps.getAdapter(key.upstream.type);
      if (!adapter.fetchKeyMetadata) {
        const result: KeyMetadataResult = { ok: false, errorMessage: '当前上游适配器不支持元数据获取' };
        const updated = await deps.updateKey(key.id, { metadataError: result.errorMessage });
        return { key: updated, result };
      }

      const config = await deps.getConfig();
      const ctx: AdapterContext = {
        baseUrl: key.upstream.baseUrl,
        apiKey,
        accessToken: accessToken || undefined,
        userId: key.userId || undefined,
        timeoutMs: config.timeoutMs,
        testModel: key.testModel || key.upstream.testModel || config.testModel,
      };

      let result: KeyMetadataResult;
      try {
        result = await adapter.fetchKeyMetadata(ctx);
      } catch (error) {
        result = { ok: false, errorMessage: safeStoredError(error) };
      }

      if (!result.ok) {
        const updated = await deps.updateKey(key.id, {
          metadataError: result.errorMessage || '远端信息获取失败',
        });
        return { key: updated, result };
      }

      const merged = mergeKeyMetadata(key, result);
      const updateData: Record<string, unknown> = {
        metadataError: merged.metadataError,
        metadataSyncedAt: deps.now(),
      };
      if (result.keyName !== undefined) updateData.keyName = merged.keyName;
      if (result.groupName !== undefined) updateData.groupName = merged.groupName;
      if (result.groupDescription !== undefined) updateData.groupDescription = merged.groupDescription;
      if (result.groupRateMultiplier !== undefined) updateData.groupRateMultiplier = merged.groupRateMultiplier;
      if (result.remoteKeyId !== undefined) updateData.remoteKeyId = merged.remoteKeyId;

      const updated = await deps.updateKey(key.id, updateData);
      return { key: updated, result };
    },
  };
}

const defaultService = createKeyMetadataService({
  findKey: async (keyId) => {
    return prisma.upstreamKey.findUnique({
      where: { id: keyId },
      include: { upstream: true },
    });
  },
  updateKey: async (keyId, data) => {
    return prisma.upstreamKey.update({ where: { id: keyId }, data });
  },
  decrypt: tryDecrypt,
  getConfig: getCollectConfig,
  getAdapter,
  now: () => new Date(),
});

export async function refreshKeyMetadata(keyId: number) {
  return defaultService.refresh(keyId);
}
