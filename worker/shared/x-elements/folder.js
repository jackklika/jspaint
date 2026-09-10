// @ts-check
// <x-folder>: a list of the pages in one folder of the site — the blog index. `path` is the folder ("posts"),
// `show` which columns ("title", "title,date"), `order` newest | oldest | name, `limit` how many, `title` a heading.
// Renders <ul class="folder folder-<path>"> of <li class="folder-item"> with the page's <title> and its date, so a
// site's stylesheet can style it (docs/DESIGN.md §3.5). Dates are when the page was last saved.
import { site_base } from "../names.js";
import { escape_html } from "./index.js";

const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})*$/;

export default {
	tag: "x-folder",
	attrs: ["path", "show", "order", "limit", "title", "rss"],
	editor: {
		label: "Folder View",
		description: "Lists the pages in a folder of your site (a posts folder, say), newest first, on the published page.",
		fallback: "<b>Posts</b><br><i>(the pages in the folder are listed here on the published page)</i>",
	},
	async render({ attrs, context }) {
		const folder = String(attrs.path || "posts").replace(/^\/+|\/+$/g, "");
		if (!FOLDER.test(folder)) { return "<i>(folder view: that folder name won't do)</i>"; }
		const show = new Set(String(attrs.show || "title,date").split(",").map((part) => part.trim()));
		const order = ["newest", "oldest", "name"].includes(attrs.order) ? attrs.order : "newest";
		const limit = Math.max(1, Math.min(200, parseInt(attrs.limit || "50", 10) || 50));
		// The folder's own index page is the listing, not an entry in it.
		const pages = (await context.files.list_pages(folder)).filter((page) => !/(^|\/)index\.html?$/i.test(page.path));
		pages.sort((a, b) => order === "name" ? a.path.localeCompare(b.path) : order === "oldest" ? a.uploaded - b.uploaded : b.uploaded - a.uploaded);
		const shown = pages.slice(0, limit);
		const items = [];
		for (const page of shown) {
			const name = page.path.slice(page.path.lastIndexOf("/") + 1).replace(/\.html?$/i, "");
			const title = (show.has("title") ? await context.files.page_title(page.path) : "") || name;
			const href = `${site_base(context.site)}/${page.path}`;
			const date = show.has("date") ? ` <small class="folder-date">${new Date(page.uploaded).toISOString().slice(0, 10)}</small>` : "";
			items.push(`<li class="folder-item"><a href="${escape_html(href)}">${escape_html(title)}</a>${date}</li>`);
		}
		const heading = attrs.title ? `<b class="folder-title">${escape_html(attrs.title)}</b>` : "";
		const list = items.length ? `<ul class="folder folder-${escape_html(folder.replace(/[^A-Za-z0-9_-]/g, "-"))}">${items.join("")}</ul>` : `<p class="folder-empty"><i>Nothing in ${escape_html(folder)}/ yet.</i></p>`;
		// A posts folder (site.json) has a feed
		const settings = await context.files.settings();
		const is_posts = !!(settings.folders && settings.folders[folder] && settings.folders[folder].kind === "posts");
		const feed = is_posts && attrs.rss !== "no" ? `<p class="folder-feed"><a href="${escape_html(`${site_base(context.site)}/${folder}/feed.xml`)}">RSS feed</a></p>` : "";
		return heading + list + feed;
	},
};
