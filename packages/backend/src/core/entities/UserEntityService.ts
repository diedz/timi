/*
 * SPDX-FileCopyrightText: syuilo and other misskey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import _Ajv from 'ajv';
import { ModuleRef } from '@nestjs/core';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import type { Packed } from '@/misc/json-schema.js';
import type { Promiseable } from '@/misc/prelude/await-all.js';
import { awaitAll } from '@/misc/prelude/await-all.js';
import { USER_ACTIVE_THRESHOLD, USER_ONLINE_THRESHOLD } from '@/const.js';
import type { MiLocalUser, MiPartialLocalUser, MiPartialRemoteUser, MiRemoteUser, MiUser } from '@/models/User.js';
import { birthdaySchema, descriptionSchema, localUsernameSchema, locationSchema, nameSchema, passwordSchema } from '@/models/User.js';
import { MiNotification } from '@/models/Notification.js';
import type { UsersRepository, UserSecurityKeysRepository, FollowingsRepository, FollowRequestsRepository, BlockingsRepository, MutingsRepository, DriveFilesRepository, NoteUnreadsRepository, UserNotePiningsRepository, UserProfilesRepository, AnnouncementReadsRepository, AnnouncementsRepository, MiUserProfile, RenoteMutingsRepository, UserMemoRepository } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import { RoleService } from '@/core/RoleService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { IdService } from '@/core/IdService.js';
import type { AnnouncementService } from '@/core/AnnouncementService.js';
import type { CustomEmojiService } from '@/core/CustomEmojiService.js';
import { AvatarDecorationService } from '@/core/AvatarDecorationService.js';
import type { OnModuleInit } from '@nestjs/common';
import type { NoteEntityService } from './NoteEntityService.js';
import type { DriveFileEntityService } from './DriveFileEntityService.js';
import type { PageEntityService } from './PageEntityService.js';

type IsUserDetailed<Detailed extends boolean> = Detailed extends true ? Packed<'UserDetailed'> : Packed<'UserLite'>;
type IsMeAndIsUserDetailed<ExpectsMe extends boolean | null, Detailed extends boolean> =
	Detailed extends true ?
		ExpectsMe extends true ? Packed<'MeDetailed'> :
		ExpectsMe extends false ? Packed<'UserDetailedNotMe'> :
		Packed<'UserDetailed'> :
	Packed<'UserLite'>;

const Ajv = _Ajv.default;
const ajv = new Ajv();

function isLocalUser(user: MiUser): user is MiLocalUser;
function isLocalUser<T extends { host: MiUser['host'] }>(user: T): user is (T & { host: null; });
function isLocalUser(user: MiUser | { host: MiUser['host'] }): boolean {
	return user.host == null;
}

function isRemoteUser(user: MiUser): user is MiRemoteUser;
function isRemoteUser<T extends { host: MiUser['host'] }>(user: T): user is (T & { host: string; });
function isRemoteUser(user: MiUser | { host: MiUser['host'] }): boolean {
	return !isLocalUser(user);
}

@Injectable()
export class UserEntityService implements OnModuleInit {
	private apPersonService: ApPersonService;
	private noteEntityService: NoteEntityService;
	private driveFileEntityService: DriveFileEntityService;
	private pageEntityService: PageEntityService;
	private customEmojiService: CustomEmojiService;
	private announcementService: AnnouncementService;
	private roleService: RoleService;
	private federatedInstanceService: FederatedInstanceService;
	private idService: IdService;
	private avatarDecorationService: AvatarDecorationService;

	constructor(
		private moduleRef: ModuleRef,

		@Inject(DI.config)
		private config: Config,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userSecurityKeysRepository)
		private userSecurityKeysRepository: UserSecurityKeysRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.followRequestsRepository)
		private followRequestsRepository: FollowRequestsRepository,

		@Inject(DI.blockingsRepository)
		private blockingsRepository: BlockingsRepository,

		@Inject(DI.mutingsRepository)
		private mutingsRepository: MutingsRepository,

		@Inject(DI.renoteMutingsRepository)
		private renoteMutingsRepository: RenoteMutingsRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.noteUnreadsRepository)
		private noteUnreadsRepository: NoteUnreadsRepository,

		@Inject(DI.userNotePiningsRepository)
		private userNotePiningsRepository: UserNotePiningsRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.announcementReadsRepository)
		private announcementReadsRepository: AnnouncementReadsRepository,

		@Inject(DI.announcementsRepository)
		private announcementsRepository: AnnouncementsRepository,

		@Inject(DI.userMemosRepository)
		private userMemosRepository: UserMemoRepository,
	) {
	}

	onModuleInit() {
		this.apPersonService = this.moduleRef.get('ApPersonService');
		this.noteEntityService = this.moduleRef.get('NoteEntityService');
		this.driveFileEntityService = this.moduleRef.get('DriveFileEntityService');
		this.pageEntityService = this.moduleRef.get('PageEntityService');
		this.customEmojiService = this.moduleRef.get('CustomEmojiService');
		this.announcementService = this.moduleRef.get('AnnouncementService');
		this.roleService = this.moduleRef.get('RoleService');
		this.federatedInstanceService = this.moduleRef.get('FederatedInstanceService');
		this.idService = this.moduleRef.get('IdService');
		this.avatarDecorationService = this.moduleRef.get('AvatarDecorationService');
	}

	//#region Validators
	public validateLocalUsername = ajv.compile(localUsernameSchema);
	public validatePassword = ajv.compile(passwordSchema);
	public validateName = ajv.compile(nameSchema);
	public validateDescription = ajv.compile(descriptionSchema);
	public validateLocation = ajv.compile(locationSchema);
	public validateBirthday = ajv.compile(birthdaySchema);
	//#endregion

	public isLocalUser = isLocalUser;
	public isRemoteUser = isRemoteUser;

	@bindThis
	public async getRelation(me: MiUser['id'], target: MiUser['id']) {
		const [
			following,
			isFollowed,
			hasPendingFollowRequestFromYou,
			hasPendingFollowRequestToYou,
			isBlocking,
			isBlocked,
			isMuted,
			isRenoteMuted,
		] = await Promise.all([
			this.followingsRepository.findOneBy({
				followerId: me,
				followeeId: target,
			}),
			this.followingsRepository.exist({
				where: {
					followerId: target,
					followeeId: me,
				},
			}),
			this.followRequestsRepository.exist({
				where: {
					followerId: me,
					followeeId: target,
				},
			}),
			this.followRequestsRepository.exist({
				where: {
					followerId: target,
					followeeId: me,
				},
			}),
			this.blockingsRepository.exist({
				where: {
					blockerId: me,
					blockeeId: target,
				},
			}),
			this.blockingsRepository.exist({
				where: {
					blockerId: target,
					blockeeId: me,
				},
			}),
			this.mutingsRepository.exist({
				where: {
					muterId: me,
					muteeId: target,
				},
			}),
			this.renoteMutingsRepository.exist({
				where: {
					muterId: me,
					muteeId: target,
				},
			}),
		]);

		return {
			id: target,
			following,
			isFollowing: following != null,
			isFollowed,
			hasPendingFollowRequestFromYou,
			hasPendingFollowRequestToYou,
			isBlocking,
			isBlocked,
			isMuted,
			isRenoteMuted,
		};
	}

	@bindThis
	public async getHasUnreadAntenna(userId: MiUser['id']): Promise<boolean> {
		/*
		const myAntennas = (await this.antennaService.getAntennas()).filter(a => a.userId === userId);

		const isUnread = (myAntennas.length > 0 ? await this.antennaNotesRepository.exist({
			where: {
				antennaId: In(myAntennas.map(x => x.id)),
				read: false,
			},
		}) : false);

		return isUnread;
		*/
		return false; // TODO
	}

	@bindThis
	public async getNotificationsInfo(userId: MiUser['id']): Promise<{
		hasUnread: boolean;
		unreadCount: number;
	}> {
		const response = {
			hasUnread: false,
			unreadCount: 0,
		};

		const latestReadNotificationId = await this.redisClient.get(`latestReadNotification:${userId}`);

		if (!latestReadNotificationId) {
			response.unreadCount = await this.redisClient.xlen(`notificationTimeline:${userId}`);
		} else {
			const latestNotificationIdsRes = await this.redisClient.xrevrange(
				`notificationTimeline:${userId}`,
				'+',
				latestReadNotificationId,
			);

			response.unreadCount = (latestNotificationIdsRes.length - 1 >= 0) ? latestNotificationIdsRes.length - 1 : 0;
		}

		if (response.unreadCount > 0) {
			response.hasUnread = true;
		}

		return response;
	}

	@bindThis
	public async getHasPendingReceivedFollowRequest(userId: MiUser['id']): Promise<boolean> {
		const count = await this.followRequestsRepository.countBy({
			followeeId: userId,
		});

		return count > 0;
	}

	@bindThis
	public getOnlineStatus(user: MiUser): 'unknown' | 'online' | 'active' | 'offline' {
		if (user.hideOnlineStatus) return 'unknown';
		if (user.lastActiveDate == null) return 'unknown';
		const elapsed = Date.now() - user.lastActiveDate.getTime();
		return (
			elapsed < USER_ONLINE_THRESHOLD ? 'online' :
			elapsed < USER_ACTIVE_THRESHOLD ? 'active' :
			'offline'
		);
	}

	@bindThis
	public getIdenticonUrl(user: MiUser): string {
		return `${this.config.url}/identicon/${user.username.toLowerCase()}@${user.host ?? this.config.host}`;
	}

	@bindThis
	public getUserUri(user: MiLocalUser | MiPartialLocalUser | MiRemoteUser | MiPartialRemoteUser): string {
		return this.isRemoteUser(user)
			? user.uri : this.genLocalUserUri(user.id);
	}

	@bindThis
	public genLocalUserUri(userId: string): string {
		return `${this.config.url}/users/${userId}`;
	}

	public async pack<ExpectsMe extends boolean | null = null, D extends boolean = false>(
		src: MiUser['id'] | MiUser,
		me?: { id: MiUser['id']; } | null | undefined,
		options?: {
			detail?: D,
			includeSecrets?: boolean,
			userProfile?: MiUserProfile,
		},
	): Promise<IsMeAndIsUserDetailed<ExpectsMe, D>> {
		const opts = Object.assign({
			detail: false,
			includeSecrets: false,
		}, options);

		const user = typeof src === 'object' ? src : await this.usersRepository.findOneByOrFail({ id: src });

		const meId = me ? me.id : null;
		const isMe = meId === user.id;
		const iAmModerator = me ? await this.roleService.isModerator(me as MiUser) : false;

		const relation = meId && !isMe && opts.detail ? await this.getRelation(meId, user.id) : null;
		const pins = opts.detail ? await this.userNotePiningsRepository.createQueryBuilder('pin')
			.where('pin.userId = :userId', { userId: user.id })
			.innerJoinAndSelect('pin.note', 'note')
			.orderBy('pin.id', 'DESC')
			.getMany() : [];
		const profile = opts.detail ? (opts.userProfile ?? await this.userProfilesRepository.findOneByOrFail({ userId: user.id })) : null;

		const followingCount = profile == null ? null :
			(profile.ffVisibility === 'public') || isMe ? user.followingCount :
			(profile.ffVisibility === 'followers') && (relation && relation.isFollowing) ? user.followingCount :
			null;

		const followersCount = profile == null ? null :
			(profile.ffVisibility === 'public') || isMe ? user.followersCount :
			(profile.ffVisibility === 'followers') && (relation && relation.isFollowing) ? user.followersCount :
			null;

		const isModerator = isMe && opts.detail ? this.roleService.isModerator(user) : null;
		const isAdmin = isMe && opts.detail ? this.roleService.isAdministrator(user) : null;
		const unreadAnnouncements = isMe && opts.detail ?
			(await this.announcementService.getUnreadAnnouncements(user)).map((announcement) => ({
				createdAt: this.idService.parse(announcement.id).date.toISOString(),
				...announcement,
			})) : null;

		const notificationsInfo = isMe && opts.detail ? await this.getNotificationsInfo(user.id) : null;

		const packed = {
			id: user.id,
			name: user.name,
			username: user.username,
			host: user.host,
			avatarUrl: user.avatarUrl ?? this.getIdenticonUrl(user),
			avatarBlurhash: user.avatarBlurhash,
			avatarDecorations: user.avatarDecorations.length > 0 ? this.avatarDecorationService.getAll().then(decorations => user.avatarDecorations.filter(ud => decorations.some(d => d.id === ud.id)).map(ud => ({
				id: ud.id,
				angle: ud.angle || undefined,
				flipH: ud.flipH || undefined,
				url: decorations.find(d => d.id === ud.id)!.url,
			}))) : [],
			isBot: user.isBot,
			isCat: user.isCat,
			instance: user.host ? this.federatedInstanceService.federatedInstanceCache.fetch(user.host).then(instance => instance ? {
				name: instance.name,
				softwareName: instance.softwareName,
				softwareVersion: instance.softwareVersion,
				iconUrl: instance.iconUrl,
				faviconUrl: instance.faviconUrl,
				themeColor: instance.themeColor,
			} : undefined) : undefined,
			emojis: this.customEmojiService.populateEmojis(user.emojis, user.host),
			onlineStatus: this.getOnlineStatus(user),
			// パフォーマンス上の理由でローカルユーザーのみ
			badgeRoles: user.host == null ? this.roleService.getUserBadgeRoles(user.id).then(rs => rs.sort((a, b) => b.displayOrder - a.displayOrder).map(r => ({
				name: r.name,
				iconUrl: r.iconUrl,
				displayOrder: r.displayOrder,
			}))) : undefined,

			...(opts.detail ? {
				url: profile!.url,
				uri: user.uri,
				movedTo: user.movedToUri ? this.apPersonService.resolvePerson(user.movedToUri).then(user => user.id).catch(() => null) : null,
				alsoKnownAs: user.alsoKnownAs
					? Promise.all(user.alsoKnownAs.map(uri => this.apPersonService.fetchPerson(uri).then(user => user?.id).catch(() => null)))
						.then(xs => xs.length === 0 ? null : xs.filter(x => x != null) as string[])
					: null,
				createdAt: this.idService.parse(user.id).date.toISOString(),
				updatedAt: user.updatedAt ? user.updatedAt.toISOString() : null,
				lastFetchedAt: user.lastFetchedAt ? user.lastFetchedAt.toISOString() : null,
				bannerUrl: user.bannerUrl,
				bannerBlurhash: user.bannerBlurhash,
				isLocked: user.isLocked,
				isSilenced: this.roleService.getUserPolicies(user.id).then(r => !r.canPublicNote),
				isSuspended: user.isSuspended,
				description: profile!.description,
				location: profile!.location,
				birthday: profile!.birthday,
				lang: profile!.lang,
				fields: profile!.fields,
				verifiedLinks: profile!.verifiedLinks,
				followersCount: followersCount ?? 0,
				followingCount: followingCount ?? 0,
				notesCount: user.notesCount,
				pinnedNoteIds: pins.map(pin => pin.noteId),
				pinnedNotes: this.noteEntityService.packMany(pins.map(pin => pin.note!), me, {
					detail: true,
				}),
				pinnedPageId: profile!.pinnedPageId,
				pinnedPage: profile!.pinnedPageId ? this.pageEntityService.pack(profile!.pinnedPageId, me) : null,
				publicReactions: profile!.publicReactions,
				ffVisibility: profile!.ffVisibility,
				twoFactorEnabled: profile!.twoFactorEnabled,
				usePasswordLessLogin: profile!.usePasswordLessLogin,
				securityKeys: profile!.twoFactorEnabled
					? this.userSecurityKeysRepository.countBy({
						userId: user.id,
					}).then(result => result >= 1)
					: false,
				roles: this.roleService.getUserRoles(user.id).then(roles => roles.filter(role => role.isPublic).sort((a, b) => b.displayOrder - a.displayOrder).map(role => ({
					id: role.id,
					name: role.name,
					color: role.color,
					iconUrl: role.iconUrl,
					description: role.description,
					isModerator: role.isModerator,
					isAdministrator: role.isAdministrator,
					displayOrder: role.displayOrder,
				}))),
				memo: meId == null ? null : await this.userMemosRepository.findOneBy({
					userId: meId,
					targetUserId: user.id,
				}).then(row => row?.memo ?? null),
				moderationNote: iAmModerator ? (profile!.moderationNote ?? '') : undefined,
			} : {}),

			...(opts.detail && isMe ? {
				avatarId: user.avatarId,
				bannerId: user.bannerId,
				isModerator: isModerator,
				isAdmin: isAdmin,
				injectFeaturedNote: profile!.injectFeaturedNote,
				receiveAnnouncementEmail: profile!.receiveAnnouncementEmail,
				alwaysMarkNsfw: profile!.alwaysMarkNsfw,
				autoSensitive: profile!.autoSensitive,
				carefulBot: profile!.carefulBot,
				autoAcceptFollowed: profile!.autoAcceptFollowed,
				noCrawle: profile!.noCrawle,
				preventAiLearning: profile!.preventAiLearning,
				isExplorable: user.isExplorable,
				isDeleted: user.isDeleted,
				twoFactorBackupCodesStock: profile?.twoFactorBackupSecret?.length === 5 ? 'full' : (profile?.twoFactorBackupSecret?.length ?? 0) > 0 ? 'partial' : 'none',
				hideOnlineStatus: user.hideOnlineStatus,
				hasUnreadSpecifiedNotes: this.noteUnreadsRepository.count({
					where: { userId: user.id, isSpecified: true },
					take: 1,
				}).then(count => count > 0),
				hasUnreadMentions: this.noteUnreadsRepository.count({
					where: { userId: user.id, isMentioned: true },
					take: 1,
				}).then(count => count > 0),
				hasUnreadAnnouncement: unreadAnnouncements!.length > 0,
				unreadAnnouncements,
				hasUnreadAntenna: this.getHasUnreadAntenna(user.id),
				hasUnreadChannel: false, // 後方互換性のため
				hasUnreadNotification: notificationsInfo?.hasUnread, // 後方互換性のため
				hasPendingReceivedFollowRequest: this.getHasPendingReceivedFollowRequest(user.id),
				unreadNotificationsCount: notificationsInfo?.unreadCount,
				mutedWords: profile!.mutedWords,
				mutedInstances: profile!.mutedInstances,
				mutingNotificationTypes: [], // 後方互換性のため
				notificationRecieveConfig: profile!.notificationRecieveConfig,
				emailNotificationTypes: profile!.emailNotificationTypes,
				achievements: profile!.achievements,
				loggedInDays: profile!.loggedInDates.length,
				policies: this.roleService.getUserPolicies(user.id),
			} : {}),

			...(opts.includeSecrets ? {
				email: profile!.email,
				emailVerified: profile!.emailVerified,
				securityKeysList: profile!.twoFactorEnabled
					? this.userSecurityKeysRepository.find({
						where: {
							userId: user.id,
						},
						select: {
							id: true,
							name: true,
							lastUsed: true,
						},
					})
					: [],
			} : {}),

			...(relation ? {
				isFollowing: relation.isFollowing,
				isFollowed: relation.isFollowed,
				hasPendingFollowRequestFromYou: relation.hasPendingFollowRequestFromYou,
				hasPendingFollowRequestToYou: relation.hasPendingFollowRequestToYou,
				isBlocking: relation.isBlocking,
				isBlocked: relation.isBlocked,
				isMuted: relation.isMuted,
				isRenoteMuted: relation.isRenoteMuted,
				notify: relation.following?.notify ?? 'none',
				withReplies: relation.following?.withReplies ?? false,
			} : {}),
		} as Promiseable<Packed<'User'>> as Promiseable<IsMeAndIsUserDetailed<ExpectsMe, D>>;

		return await awaitAll(packed);
	}

	public packMany<D extends boolean = false>(
		users: (MiUser['id'] | MiUser)[],
		me?: { id: MiUser['id'] } | null | undefined,
		options?: {
			detail?: D,
			includeSecrets?: boolean,
		},
	): Promise<IsUserDetailed<D>[]> {
		return Promise.all(users.map(u => this.pack(u, me, options)));
	}
}