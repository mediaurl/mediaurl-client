import Url from "url-parse";
import settings from "../settings";

export const stripAddonUrl = (url: string) =>
  url
    .replace(/\/[^/]+\.watched$/, "")
    .replace(/\/mediaurl[^/]*\.json$/, "")
    .replace(/\/$/, "");

export const getCleanAddonUrl = (
  url: string,
  baseUrl?: string,
  action?: string,
  sdkVersion?: string
) => {
  let temp = new Url(baseUrl ?? url);
  temp.set("pathname", stripAddonUrl(temp.pathname));
  if (baseUrl) {
    temp = new Url(url, temp);
    temp.set("pathname", stripAddonUrl(temp.pathname));
  }
  if (action) {
    let legacy = settings.useLegacyAddonRoutes;
    if (legacy && sdkVersion && sdkVersion.indexOf("0.") !== 0) {
      legacy = false;
    }
    if (legacy && /\/mediaurl[^/]*\.json$/.test(url)) {
      legacy = false;
    }
    if (legacy) {
      temp.set(
        "pathname",
        temp.pathname + (temp.pathname === "/" ? "" : "/") + action + ".watched"
      );
    } else {
      temp.set(
        "pathname",
        temp.pathname +
          (temp.pathname === "/" ? "" : "/") +
          (action === "addon" ? "mediaurl.json" : `mediaurl-${action}.json`)
      );
    }
  }
  return temp.toString();
};
