/** Normalized shapes the tools work with, independent of NodeBB's raw payloads. */

export interface Author {
	uid: number;
	username: string;
	userslug?: string;
}

export interface QnaState {
	isQuestion: boolean;
	isSolved: boolean;
	solvedPid?: number;
}

export interface TopicSummary {
	tid: number;
	title: string;
	slug?: string;
	url: string;
	cid?: number;
	categoryName?: string;
	author?: Author;
	postcount: number;
	viewcount: number;
	votes?: number;
	timestamp?: number;
	lastposttime?: number;
	tags: string[];
	locked?: boolean;
	deleted?: boolean;
	/** Present only when the Q&A plugin is active on this forum. */
	qna?: QnaState;
}

export interface PostItem {
	pid: number;
	tid?: number;
	index?: number;
	author?: Author;
	timestamp?: number;
	votes?: number;
	upvotes?: number;
	/** Plain text, decoded from NodeBB's rendered HTML. */
	content: string;
	url: string;
	/** True when the Q&A plugin marks this post as the accepted answer. */
	isAcceptedAnswer?: boolean;
}

export interface TopicDetail extends TopicSummary {
	posts: PostItem[];
	/** Total posts in the topic, which may exceed posts.length when truncated. */
	totalPosts: number;
	truncated: boolean;
}

export interface SearchHit {
	pid: number;
	tid: number;
	title: string;
	url: string;
	categoryName?: string;
	author?: Author;
	timestamp?: number;
	snippet: string;
	/** Relevance in [0,1]: the forum's ordering, or our own when we ranked locally. */
	score: number;
	/** Present only when the Q&A plugin is active. */
	isSolved?: boolean;
}

export interface CategoryNode {
	cid: number;
	name: string;
	description?: string;
	slug?: string;
	topicCount?: number;
	postCount?: number;
	url: string;
	children: CategoryNode[];
}

export type TopicListSource = 'recent' | 'popular' | 'top' | 'unread';
