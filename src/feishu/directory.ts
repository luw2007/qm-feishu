import type { DirectoryBatch } from '../types.js';
import { feishuResponseError } from './client.js';

export type FeishuDirectoryApiClient = {
  im: {
    v1: {
      chat: {
        list(payload?: { params?: { page_size?: number; page_token?: string } }): Promise<{
          code?: number;
          data?: { items?: Array<{ chat_id?: string; name?: string }>; page_token?: string; has_more?: boolean };
        }>;
      };
      chatMembers: {
        get(payload: {
          params?: { page_size?: number; page_token?: string };
          path: { chat_id: string };
        }): Promise<{
          code?: number;
          data?: { items?: Array<{ member_id?: string; name?: string }>; page_token?: string; has_more?: boolean };
        }>;
      };
    };
  };
};

export async function fetchFeishuDirectory(client: FeishuDirectoryApiClient): Promise<DirectoryBatch> {
  const channels: NonNullable<DirectoryBatch['channels']> = [];
  const members = new Map<string, { principalId: string; displayName?: string }>();

  let chatPageToken: string | undefined;
  do {
    const chatResponse = await client.im.v1.chat.list({
      params: { page_size: 100, ...(chatPageToken ? { page_token: chatPageToken } : {}) },
    });
    if (chatResponse.code !== undefined && chatResponse.code !== 0) {
      throw feishuResponseError(200, chatResponse.code);
    }
    for (const item of chatResponse.data?.items ?? []) {
      if (!item.chat_id) continue;
      channels.push({ id: item.chat_id, ...(item.name ? { name: item.name } : {}) });

      let memberPageToken: string | undefined;
      do {
        const memberResponse = await client.im.v1.chatMembers.get({
          params: { page_size: 100, ...(memberPageToken ? { page_token: memberPageToken } : {}) },
          path: { chat_id: item.chat_id },
        });
        if (memberResponse.code !== undefined && memberResponse.code !== 0) {
          throw feishuResponseError(200, memberResponse.code);
        }
        for (const member of memberResponse.data?.items ?? []) {
          if (!member.member_id) continue;
          members.set(member.member_id, {
            principalId: member.member_id,
            ...(member.name ? { displayName: member.name } : {}),
          });
        }
        memberPageToken = memberResponse.data?.has_more ? memberResponse.data.page_token : undefined;
      } while (memberPageToken);
    }
    chatPageToken = chatResponse.data?.has_more ? chatResponse.data.page_token : undefined;
  } while (chatPageToken);

  return { channels, members: [...members.values()] };
}
