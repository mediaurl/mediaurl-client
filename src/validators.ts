import {
  Addon,
  AddonActions,
  AddonResponse,
  BaseDirectoryItem,
  CatalogRequest,
  CatalogResponse,
  DirectoryItem,
  getClientValidators,
  ItemResponse,
  MainItem,
} from "@mediaurl/schema";
import semver from "semver";

type MigrateResult = {
  action?: string;
  validate?: boolean;
  data: any;
};

type MigrateFn = (data: any, callingAddon?: Addon) => MigrateResult;

type Migrations = Record<
  string,
  {
    request?: MigrateFn;
    response?: MigrateFn;
  }
>;

const isAddonLegacyV1 = (addon?: Addon) => {
  const sdkVersion = <string>addon?.sdkVersion;
  return !sdkVersion || semver.lt(sdkVersion, "2.0.0-alpha.0");
};

const isAddonLegacyV2 = (addon?: Addon) => {
  const sdkVersion = <string>addon?.sdkVersion;
  return !sdkVersion || semver.lt(sdkVersion, "2.2.0-alpha.0");
};

const migrateDirectoryV2 = (
  directory: {
    options?: any;
    items?: MainItem[];
    initialData?: BaseDirectoryItem["initialData"];
  },
  migrateItems = true
) => {
  if (directory.options?.imageShape) {
    directory.options.shape = directory.options.imageShape;
    delete directory.options.imageShape;
  }
  if (directory.options?.shape === "regular") {
    directory.options.shape = "portrait";
  }

  if (migrateItems && directory.items) {
    directory.initialData = {
      items: directory.items,
      nextCursor: null,
    };
    delete directory.items;
  }
};

const migrations: Migrations = {
  addon: {
    response: (data: AddonResponse, callingAddon) => {
      if ((<any>data).type === "server") return { data };

      let addon = <Addon>data;
      let any: any = addon;

      if (isAddonLegacyV1(addon)) {
        delete any.poster;

        if (any.flags) {
          Object.assign(any, any.flags);
          delete any.flags;
        }

        if (any.metadata?.url) {
          if (!any.endpoints) any.endpoints = [];
          any.endpoints.push(any.metadata.url);
        }
        delete any.metadata;

        if (any.type === "repository") {
          if (!any.actions) any.actions = [];
          any._isLegacyRepositoryAddon = true;
        }
        delete any.type;

        if (any.requestArgs) {
          if (!any.triggers?.length) any.triggers = <any>any.requestArgs;
        }
        delete any.requestArgs;

        if (any.requirements) {
          any.requirements = any.requirements.map((req) =>
            typeof req === "string" ? req : (<any>req).url ?? (<any>req).id
          );
        }

        if (any.actions) {
          let i = any.actions.indexOf(<any>"directory");
          if (i !== -1) {
            any.actions.splice(i, 1, "catalog");
            any.catalogs = <any>any.rootDirectories;
            delete any.rootDirectories;
          }
          i = any.actions.indexOf("iptv");
          if (i !== -1) {
            any.splice(i, 1);
          }
        }

        if (any.defaultDirectoryOptions || any.defaultDirectoryFeatures) {
          if (!any.catalogs?.length) {
            any.catalogs = [{}];
          }
          any.catalogs = any.catalogs.map((catalog) => ({
            ...catalog,
            options: {
              ...(<any>any.defaultDirectoryOptions),
              ...catalog.options,
            },
            features: {
              ...(<any>any.defaultDirectoryFeatures),
              ...catalog.features,
            },
          }));
          delete any.defaultDirectoryOptions;
          delete any.defaultDirectoryFeatures;
        }

        if (any.dashboards) {
          any.dashboards = any.dashboards.map((dashboard) => {
            dashboard.catalogId = <any>dashboard.rootId;
            delete dashboard.rootId;

            if ((<any>dashboard.config)?.showOnHomescreen === false) {
              dashboard.hideOnHomescreen = true;
              delete dashboard.config;
            }

            if (!dashboard.catalogId && typeof dashboard.id === "string") {
              // This is somehow unsfe, might result in invalid catalog ID's
              const m = /^([^/:]+?)\/(.+)/.exec(dashboard.id);
              if (m) {
                dashboard.catalogId = m[1];
              }
            }

            const showOnHomescreen = (<any>dashboard.config)?.showOnHomescreen;
            if (showOnHomescreen === true || showOnHomescreen === false) {
              dashboard.hideOnHomescreen = !showOnHomescreen;
              delete dashboard.config;
            }

            return dashboard;
          });
        }
      }

      if (!any.pages && any.dashboards) {
        any.pages = [{ dashboards: any.dashboards }];
      }
      delete any.dashboards;

      if (isAddonLegacyV2(addon)) {
        addon.catalogs?.forEach((catalog) => migrateDirectoryV2(catalog));
        addon.pages?.forEach((page) => {
          page.dashboards?.forEach((dashboard) => {
            if (dashboard.type === undefined || dashboard.type === null) {
              // @ts-ignore
              dashboard.type = "directory";
            }
            if (dashboard.type === "directory") {
              migrateDirectoryV2(dashboard);
            }
          });
        });
      }

      return { data: addon };
    },
  },
  repository: {
    request: (data: any, callingAddon) => {
      data = getClientValidators().actions.addon.request(data);
      return { data, validate: false };
    },
    response: (data: Addon[], callingAddon) => {
      data = data
        .map(
          (addon) =>
            applyMigration("addon", "response", addon, callingAddon).data
        )
        .map((addon) => getClientValidators().models.addon(addon));
      return { data, validate: false };
    },
  },
  catalog: {
    request: (data: CatalogRequest, callingAddon) => {
      let action: string | undefined = undefined;
      if (isAddonLegacyV1(callingAddon)) {
        action = "directory";
        data.rootId = data.catalogId;
        delete data.catalogId;
      }
      return { action, data };
    },
    response: (data: CatalogResponse, callingAddon) => {
      if (isAddonLegacyV1(callingAddon)) {
        const any: any = data;
        if (data.items) {
          data.items = data.items.map((item) => {
            item = applyMigration("item", "response", item, callingAddon).data;
            if (item.type === "directory") {
              item.catalogId = <any>item.rootId;
              delete item.rootId;
            }
            return item;
          });
        }
        data.catalogId = <string>any.rootId;
        delete any.rootId;
      } else if (isAddonLegacyV2(callingAddon)) {
        data.items?.forEach((item) => {
          if (item.type === "directory") {
            migrateDirectoryV2(item);
          }
        });
        migrateDirectoryV2(data, false);
      }
      return { data };
    },
  },
  item: {
    response: (data: ItemResponse, callingAddon) => {
      if (isAddonLegacyV1(callingAddon)) {
        if (data) {
          if (data?.similarItems) {
            data.similarItems = (<DirectoryItem[]>data.similarItems).map(
              (s) => {
                s.catalogId = <any>s.rootId;
                delete s.rootId;
                return s;
              }
            );
          }
        }
      } else if (isAddonLegacyV2(callingAddon)) {
        if (data?.similarItems) {
          (data.similarItems as DirectoryItem[]).forEach((directory) => {
            if (directory.type === undefined || directory.type === null) {
              // @ts-ignore
              directory.type = "directory";
            }
            migrateDirectoryV2(directory);
            directory.initialData?.items?.forEach((item) => {
              if (item.type === "directory") {
                migrateDirectoryV2(item);
              }
            });
          });
        }
      }
      return { data };
    },
  },
};

const applyMigration = <T>(
  action: AddonActions,
  type: "request" | "response",
  data: T,
  callingAddon?: Addon
): MigrateResult => {
  const migrate = migrations[action]?.[type];
  if (migrate) return migrate(data, callingAddon);
  return { action, data };
};

export const validateAction = <T>(
  action: AddonActions,
  type: "request" | "response",
  data: T,
  callingAddon?: Addon
) => {
  const res = applyMigration(action, type, data, callingAddon);

  if (res.validate ?? true) {
    const validate = getClientValidators().actions[action]?.[type];
    if (!validate) {
      throw new Error(`No validator for ${action}.${type} found`);
    }
    data = <T>validate(res.data);
  }

  return {
    action: res.action ?? action,
    data,
  };
};
