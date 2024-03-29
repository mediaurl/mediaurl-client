import {
  Addon,
  AddonActions,
  AddonRequest,
  Catalog,
  DashboardItem,
  getClientValidators,
  ItemTypes,
  Page,
  TaskRequest,
  TaskResponse,
} from "@mediaurl/schema";
import cloneDeep from "lodash.clonedeep";
import flatten from "lodash.flatten";
import uniq from "lodash.uniq";
import semver from "semver";
import { createAddon } from "./model";
import settings from "./settings";
import {
  AddonCallAction,
  AddonCallOutput,
  AddonCallProps,
  AddonCallResult,
  AddonEndpointIterator,
  AddonInfos,
  ConvertedRequirement,
} from "./types";
import { getCleanAddonUrl, stripAddonUrl } from "./utils/addonUrl";
import { analyzeEndpoints } from "./utils/analyzeEndpoints";
import { fetch } from "./utils/fetch";
import { validateAction } from "./validators";

const clientVersion: string = require("../package.json").version;

export abstract class BaseAddonClass {
  public readonly props: Addon;
  public readonly infos: AddonInfos;

  constructor(props: Addon, infos: AddonInfos) {
    this.props = createAddon(props);
    this.infos = infos;
  }

  public abstract clone(): BaseAddonClass;

  /**
   * If true, this addon can't be overwritten by another one.
   */
  public abstract isImmutable(): boolean;

  public getSdkVersion() {
    return <string>this.props.sdkVersion ?? "0.33.0";
  }

  public isSdkNewerThan(sdkVersion?: string) {
    return semver.gt(this.getSdkVersion(), sdkVersion ?? "0.33.0");
  }

  public isLegacy() {
    return (<any>this.props)._isLegacyRepositoryAddon
      ? true
      : !this.isSdkNewerThan("2.0.0-alpha.0");
  }

  public isNewerThan(version?: string) {
    return semver.gt(this.props.version ?? "0.0.0", version ?? "0.0.0");
  }

  public getActions() {
    return this.props.actions ?? [];
  }

  public getEndpoints() {
    return this.props.endpoints ?? [];
  }

  public getRequirements() {
    return this.props.requirements ?? [];
  }

  public getConvertedRequirements() {
    const isLegacy = this.isLegacy();
    return this.getRequirements().map((req) => {
      let legacyId: string | null = null;
      const endpoints: string[] = [];

      if (req.includes("//")) {
        endpoints.push(stripAddonUrl(req));
      } else if (isLegacy && !req.includes("/")) {
        // Legacy, first try to get this addon by it's ID
        legacyId = req;
      } else {
        for (const endpoint of this.getEndpoints()) {
          endpoints.push(getCleanAddonUrl(req, endpoint));
        }
      }

      return {
        legacyId,
        endpoints: uniq(endpoints),
      };
    });
  }

  public matchesRequirement(req: ConvertedRequirement) {
    if (
      this.getEndpoints().find((endpoint) => req.endpoints.includes(endpoint))
    ) {
      if (req.legacyId !== null && req.legacyId !== this.props.id) {
        console.warn("Matched requirements via endpoints, but not via ID");
        return false;
      }
      return true;
    }
    if (req.legacyId !== null && req.legacyId === this.props.id) {
      return true;
    }
    return false;
  }

  public hasRequirement(other: BaseAddonClass) {
    const reqs = this.getConvertedRequirements();
    for (const req of reqs) {
      for (const endpoint in req.endpoints) {
        if (other.getEndpoints().includes(endpoint)) {
          return true;
        }
      }
    }
    for (const req of reqs) {
      if (req.legacyId && req.legacyId === other.props.id) {
        // console.log(
        //   `Addon ${this.props.id} found requirement ${other.props.id} via legacy ID`
        // );
        return true;
      }
    }
    return false;
  }

  public getItemTypes(): ItemTypes[] {
    return uniq(
      flatten([
        ...(this.props.itemTypes ?? []),
        ...(this.getActions().includes("catalog")
          ? this.props.catalogs?.map((catalog) => catalog.itemTypes ?? []) ?? []
          : []),
      ])
    );
  }

  protected convertCatalog(catalog: Catalog): Catalog {
    const id = catalog.id ?? "";
    return {
      ...catalog,
      type: "directory",
      addonId: catalog.addonId ?? this.props.id,
      catalogId: id,
      id,
      key: `${this.props.id}/${id}`,
      name: catalog.name ?? this.props.name,
      itemTypes: catalog.itemTypes ?? this.getItemTypes(),
      options: {
        shape: "portrait",
        size: "normal",
        displayName: true,
        ...catalog.options,
      },
    };
  }

  protected createDefaultCatalog(): Catalog {
    return {
      type: "directory",
      addonId: this.props.id,
      catalogId: "",
      id: "",
      key: `${this.props.id}/`,
    };
  }

  public getCatalogs() {
    return [
      ...(this.props.catalogs ?? []),
      ...(!this.props.catalogs?.length && this.getActions().includes("catalog")
        ? [this.createDefaultCatalog()]
        : []),
    ].map((catalog) => this.convertCatalog(catalog));
  }

  public getCatalog(id: string) {
    const catalogs = this.props.catalogs?.length
      ? this.props.catalogs
      : [this.createDefaultCatalog()];
    let c = this.props.catalogs?.find((catalog) => (catalog.id ?? "") === id);

    // This is a dirty workaround for badly written addons.
    // If there is just one catalog and has a non-empty ID,
    // directories should always define the `catalogId` property.
    if (!c && !id && catalogs.length === 1) {
      c = catalogs[0];
    }

    return c ? this.convertCatalog(c) : null;
  }

  public getPages() {
    const pages = [...(this.props.pages ?? [])];
    if (pages.length === 0 && this.getActions().includes("catalog")) {
      pages.push(<Page>{ dashboards: this.getCatalogs() });
    }
    return pages.map((page) => {
      page = {
        ...page,
        id: page.id ?? "",
        key: `${this.props.id}/${page.id ?? ""}`,
      };
      page.dashboards = (page.dashboards ?? []).map((item) => {
        switch (item.type) {
          default:
            // @ts-ignore
            throw new Error(`Unknown dashboard item type: ${item.type}`);
          case "copyItems":
            return {
              ...item,
              addonId: item.addonId || this.props.id,
              pageId: item.pageId || "",
            };
          case "channel":
          case "iptv":
          case "movie":
          case "series":
          case "unknown":
            return item;
          case "directory":
            return {
              ...item,
              addonId: item.addonId ?? this.props.id,
              pageId: item.pageId ?? page.id,
              id: item.id ?? "",
              key: `${page.key}/${item.id ?? ""}`,
            };
        }
      });
      return page;
    });
  }

  public abstract call<A extends AddonCallAction>(
    props: AddonCallProps<A>
  ): AddonCallResult<A>;
}

export class AddonClass extends BaseAddonClass {
  protected allowedActions: AddonActions[];

  constructor(props: Addon, infos: AddonInfos) {
    super(props, infos);
    this.allowedActions = ["selftest", "addon", ...(props.actions ?? [])];
    if ((<any>props)._isLegacyRepositoryAddon) {
      this.allowedActions.push(<any>"repository");
    }
  }

  public clone() {
    return new AddonClass(cloneDeep(this.props), cloneDeep(this.infos));
  }

  public isImmutable() {
    return false;
  }

  public async *iterateEndpoints(): AsyncGenerator<
    AddonEndpointIterator,
    void,
    unknown
  > {
    const triedEndpoints = new Set<string>();
    let lastError: Error | null = null;

    for (;;) {
      let endpoint: string | null = null;
      for (const e of this.getEndpoints()) {
        if (!triedEndpoints.has(e)) {
          endpoint = e;
          break;
        }
      }
      if (endpoint === null) {
        if (lastError) throw lastError;
        return;
      }
      triedEndpoints.add(endpoint);

      yield {
        endpoint,
        onError: async (error: Error) => {
          lastError = error;

          // If the current endpoint is the first one, move it to end of the list.
          if (this.props.endpoints?.[0] === endpoint) {
            this.props.endpoints.shift();
            this.props.endpoints.push(endpoint);
          }
        },
        onSuccess: async () => {},
      };
    }
  }

  public async call<A extends AddonCallAction>({
    options,
    action,
    input,
    onWarning,
  }: AddonCallProps<A>): AddonCallResult<A> {
    if (!this.allowedActions.includes(action)) {
      throw new Error(
        `Addon ${this.props.id} does not have the action "${action}`
      );
    }

    input.clientVersion = clientVersion;

    const validated = validateAction(action, "request", input, this.props);
    const outAction = <string>validated.action;
    input = validated.data;

    const headers: any = {
      "user-agent": options.userAgent,
      "content-type": "application/json; charset=utf-8",
    };
    if (settings.useLegacyAddonRoutes) {
      headers["watched-sig"] = options.signature ?? "";
    } else {
      headers["mediaurl-signature"] = options.signature ?? "";
    }

    let url: string;
    let data: AddonCallOutput<A>;

    if (action === "addon") {
      // Quickly try different endpoints and use the fastest one
      const res = await analyzeEndpoints({
        endpoints: this.getEndpoints(),
        allowServerResponses: false,
        options,
        endpointType: "addon",
        body: <AddonRequest>input,
        callback: async (url, fn) => await fn(),
      });
      if (res === null || res.length === 0) {
        throw new Error("No working endpoint found");
      }
      data = res[0].props!;
      const endpoint = data.endpoints?.[0]!;
      if (this.props.endpoints?.[0] !== endpoint) {
        if (!this.props.endpoints) this.props.endpoints = [];
        const i = this.props.endpoints.indexOf(endpoint);
        if (i !== -1) this.props.endpoints.splice(i, 1);
        this.props.endpoints.splice(0, 0, endpoint);
      }
      url = getCleanAddonUrl(
        endpoint,
        undefined,
        outAction,
        <string>this.props.sdkVersion
      );
    } else {
      // Slowly fallback to other endpoints
      const body = JSON.stringify(input);
      const it = this.iterateEndpoints();
      for (;;) {
        const result = await it.next();
        if (result.done) {
          throw new Error("No working endpoint found");
        }

        url = getCleanAddonUrl(
          result.value.endpoint,
          undefined,
          outAction,
          <string>this.props.sdkVersion
        );

        try {
          const res = await fetch(url, { method: "POST", headers, body });

          let text: string;
          try {
            text = await res.text();
          } catch (error) {
            throw new Error(`${res.status} ${res.statusText}`);
          }

          try {
            data = JSON.parse(text);
          } catch (error) {
            throw new Error(
              `${res.status} ${res.statusText} - ${text.substr(0, 200)}`
            );
          }
        } catch (error) {
          if (onWarning) onWarning(error);
          await result.value.onError(error);
          continue;
        }

        await result.value.onSuccess();
        break;
      }
    }

    if (settings.useLegacyAddonRoutes && !this.isSdkNewerThan("1.1.0")) {
      url = getCleanAddonUrl(
        url,
        undefined,
        "task",
        <string>this.props.sdkVersion
      );
    }

    // Check the response and handle tasks
    for (;;) {
      if ((<any>data)?.kind !== "taskRequest") {
        if ((<any>data)?.error) {
          throw new Error((<any>data).error);
        }
        return validateAction(action, "response", data, this.props).data;
      }

      const task: TaskRequest = getClientValidators().models.task.request(data);
      let taskData: TaskResponse["data"];
      try {
        const fn = options.taskHandlers[task.data.type];
        if (!fn) throw new Error(`Unknown task type "${task.data.type}"`);
        taskData = await fn(this, <any>task.data);
      } catch (error) {
        if (onWarning) {
          onWarning(
            new Error(`Failed executing task ${task.id}: ${error.message}`)
          );
        }
        taskData = {
          error: String(error.message),
        };
      }

      const taskResponse: TaskResponse =
        getClientValidators().models.task.response({
          kind: "taskResponse",
          id: task.id,
          data: taskData,
        });

      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(taskResponse),
      });
      data = await res.json();
    }
  }
}
