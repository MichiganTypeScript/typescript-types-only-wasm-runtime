// The screen the checker painted, read out of a checkpoint with no Node APIs:
// render-frame.ts does the same for PNGs but pulls in zlib and Buffer.
import { decodeTrie } from "../../cfg/trie";

const WIDTH = 320;
const HEIGHT = 200;
/// the first frame's screen, before any `entry` call has returned its own
const SCREEN = 4677984;
const PALETTE_SIGNATURE = [0, 0, 0, 31, 23, 11, 23, 15, 7, 75, 75, 75];

export const DOOM_FN_NAMES = (
  "AM_activateNewScale,AM_saveScaleAndLoc,AM_restoreScaleAndLoc,AM_addMark,AM_findMinMaxBoundaries,AM_changeWindowLoc,AM_initVariables,AM_loadPics,AM_unloadPics,AM_clearMarks,AM_LevelInit,AM_Stop,AM_Start,AM_minOutWindowScale,AM_maxOutWindowScale,AM_Responder,AM_changeWindowScale,AM_doFollowPlayer,AM_Ticker,AM_clipMline,AM_drawFline,AM_drawMline,AM_drawGrid,AM_drawWalls,AM_rotate," +
  "AM_drawLineCharacter,AM_drawPlayers,AM_drawThings,AM_drawMarks,AM_drawCrosshair,AM_Drawer,D_PostEvent,D_ProcessEvents,D_Display,D_PageDrawer,D_DoomLoop,D_OneFrame,D_DoAdvanceDemo,D_PageTicker,D_AdvanceDemo,D_StartTitle,D_AddFile,IdentifyVersion,FindResponseFile,D_DoomMain,ExpandTics,HSendPacket,HGetPacket," +
  "GetPackets,NetUpdate,CheckAbort,D_ArbitrateNetStart,D_CheckNetGame,D_QuitNetGame,TryRunTics,F_StartFinale,F_Responder,F_CastResponder,F_Ticker,F_StartCast,F_CastTicker,F_TextWrite,F_CastPrint,F_CastDrawer,F_DrawPatchCol,F_BunnyScroll,F_Drawer,wipe_shittyColMajorXform,wipe_initColorXForm,wipe_doColorXForm,wipe_exitColorXForm,wipe_initMelt,wipe_doMelt,wipe_exitMelt,wipe_StartScreen," +
  "wipe_EndScreen,wipe_ScreenWipe,G_BuildTiccmd,G_DoLoadLevel,G_Responder,G_Ticker,G_DoReborn,G_DoNewGame,G_DoLoadGame,G_DoSaveGame,G_DoPlayDemo,G_DoCompleted,G_DoWorldDone,G_ReadDemoTiccmd,G_WriteDemoTiccmd,G_DeathMatchSpawnPlayer,G_CheckSpot,G_InitNew,G_PlayerFinishLevel,G_CheckDemoStatus,G_PlayerReborn,G_ScreenShot,G_ExitLevel,G_SecretExitLevel,G_WorldDone," +
  "G_LoadGame,G_SaveGame,G_DeferedInitNew,G_RecordDemo,G_BeginRecording,G_DeferedPlayDemo,G_TimeDemo,HUlib_initTextLine,HUlib_addCharToTextLine,HUlib_delCharFromTextLine,HUlib_drawTextLine,HUlib_eraseTextLine,HUlib_initSText,HUlib_addLineToSText,HUlib_addMessageToSText,HUlib_drawSText,HUlib_eraseSText,HUlib_initIText,HUlib_delCharFromIText,HUlib_resetIText,HUlib_keyInIText,HUlib_drawIText,HUlib_eraseIText,HU_Init,HU_Start," +
  "HU_Drawer,HU_Erase,HU_Ticker,HU_queueChatChar,HU_dequeueChatChar,HU_Responder,I_InitGraphics,I_ShutdownGraphics,I_SetPalette,I_UpdateNoBlit,I_FinishUpdate,I_StartFrame,I_StartTic,I_InitSound,I_SubmitSound,I_ShutdownSound,I_SetChannels,I_GetSfxLumpNum,I_StartSound,I_StopSound,I_SoundIsPlaying,I_UpdateSoundParams,I_ShutdownMusic,I_SetMusicVolume,I_PauseSong," +
  "I_ResumeSong,I_RegisterSong,I_PlaySong,I_StopSong,I_UnRegisterSong,I_InitNetwork,I_NetCmd,I_GetTime,ts_post_input,I_Tactile,I_BaseTiccmd,I_ZoneBase,I_Init,I_Quit,I_WaitVBL,I_AllocLow,I_Error,M_CheckParm,M_ClearBox,M_AddToBox,cht_CheckCheat,cht_GetParam,FixedMul,FixedDiv,M_NewGame," +
  "M_Options,M_LoadGame,M_ReadSaveStrings,M_SaveGame,M_ReadThis,M_QuitDOOM,M_QuitResponse,M_DrawMainMenu,M_Episode,M_DrawEpisode,M_ChooseSkill,M_VerifyNightmare,M_DrawNewGame,M_EndGame,M_EndGameResponse,M_ChangeMessages,M_ChangeDetail,M_SizeDisplay,M_ChangeSensitivity,M_Sound,M_DrawOptions,M_DrawThermo,M_ReadThis2,M_DrawReadThis1,M_FinishReadThis," +
  "M_DrawReadThis2,M_SfxVol,M_MusicVol,M_DrawSound,M_LoadSelect,M_DrawLoad,M_DrawSaveLoadBorder,M_WriteText,M_SaveSelect,M_DrawSave,M_StringWidth,M_DoSave,M_QuickSaveResponse,M_QuickSave,M_StartControlPanel,M_QuickLoadResponse,M_QuickLoad,M_StringHeight,M_Responder,M_Drawer,M_Ticker,M_Init,M_WriteFile,M_ReadFile,M_SaveDefaults," +
  "M_LoadDefaults,WritePCXfile,M_ScreenShot,P_Random,M_Random,M_ClearRandom,T_MoveCeiling,P_RemoveActiveCeiling,EV_DoCeiling,P_ActivateInStasisCeiling,P_AddActiveCeiling,EV_CeilingCrushStop,T_VerticalDoor,EV_DoLockedDoor,EV_DoDoor,EV_VerticalDoor,P_SpawnDoorCloseIn30,P_SpawnDoorRaiseIn5Mins,P_RecursiveSound,P_NoiseAlert,P_CheckMeleeRange,P_CheckMissileRange,P_Move,P_TryWalk,P_NewChaseDir," +
  "P_LookForPlayers,A_KeenDie,A_Fall,A_Look,A_Chase,A_FaceTarget,A_PosAttack,A_SPosAttack,A_CPosAttack,A_CPosRefire,A_SpidRefire,A_BspiAttack,A_TroopAttack,A_SargAttack,A_HeadAttack,A_CyberAttack,A_BruisAttack,A_SkelMissile,A_Tracer,A_SkelWhoosh,A_SkelFist,PIT_VileCheck,A_VileChase,A_VileStart,A_StartFire," +
  "A_Fire,A_FireCrackle,A_VileTarget,A_VileAttack,A_FatRaise,A_FatAttack1,A_FatAttack2,A_FatAttack3,A_SkullAttack,A_PainShootSkull,A_PainAttack,A_PainDie,A_Scream,A_XScream,A_Pain,A_Explode,A_BossDeath,A_Hoof,A_Metal,A_BabyMetal,A_OpenShotgun2,A_LoadShotgun2,A_CloseShotgun2,A_BrainAwake,A_BrainPain," +
  "A_BrainScream,A_BrainExplode,A_BrainDie,A_BrainSpit,A_SpawnSound,A_SpawnFly,A_PlayerScream,T_MovePlane,T_MoveFloor,EV_DoFloor,EV_BuildStairs,P_GiveAmmo,P_GiveWeapon,P_GivePower,P_TouchSpecialThing,P_KillMobj,P_DamageMobj,T_FireFlicker,P_SpawnFireFlicker,T_LightFlash,P_SpawnLightFlash,T_StrobeFlash,P_SpawnStrobeFlash,EV_StartLightStrobing,EV_TurnTagLightsOff," +
  "EV_LightTurnOn,T_Glow,P_SpawnGlowingLight,PIT_StompThing,P_TeleportMove,PIT_CheckLine,PIT_CheckThing,P_CheckPosition,P_TryMove,P_ThingHeightClip,P_HitSlideLine,PTR_SlideTraverse,P_SlideMove,PTR_AimTraverse,PTR_ShootTraverse,P_AimLineAttack,P_LineAttack,PTR_UseTraverse,P_UseLines,PIT_RadiusAttack,P_RadiusAttack,PIT_ChangeSector,P_ChangeSector,P_AproxDistance,P_PointOnLineSide," +
  "P_BoxOnLineSide,P_PointOnDivlineSide,P_InterceptVector,P_LineOpening,P_UnsetThingPosition,P_SetThingPosition,P_BlockLinesIterator,P_BlockThingsIterator,PIT_AddLineIntercepts,PIT_AddThingIntercepts,P_TraverseIntercepts,P_PathTraverse,P_SetMobjState,P_RemoveMobj,P_ExplodeMissile,P_XYMovement,P_ZMovement,P_NightmareRespawn,P_SpawnMobj,P_MobjThinker,P_RespawnSpecials,P_SpawnPlayer,P_SpawnMapThing,P_SpawnPuff,P_SpawnBlood," +
  "P_CheckMissileSpawn,P_SpawnMissile,P_SpawnPlayerMissile,T_PlatRaise,P_RemoveActivePlat,EV_DoPlat,P_ActivateInStasis,P_AddActivePlat,EV_StopPlat,P_SetPsprite,P_BringUpWeapon,P_CheckAmmo,P_FireWeapon,P_DropWeapon,A_WeaponReady,A_ReFire,A_CheckReload,A_Lower,A_Raise,A_GunFlash,A_Punch,A_Saw,A_FireMissile,A_FireBFG,A_FirePlasma," +
  "P_BulletSlope,P_GunShot,A_FirePistol,A_FireShotgun,A_FireShotgun2,A_FireCGun,A_Light0,A_Light1,A_Light2,A_BFGSpray,A_BFGsound,P_SetupPsprites,P_MovePsprites,P_ArchivePlayers,P_UnArchivePlayers,P_ArchiveWorld,P_UnArchiveWorld,P_ArchiveThinkers,P_UnArchiveThinkers,P_ArchiveSpecials,P_UnArchiveSpecials,P_LoadVertexes,P_LoadSegs,P_LoadSubsectors,P_LoadSectors," +
  "P_LoadNodes,P_LoadThings,P_LoadLineDefs,P_LoadSideDefs,P_LoadBlockMap,P_GroupLines,P_SetupLevel,P_Init,P_DivlineSide,P_InterceptVector2,P_CrossSubsector,P_CrossBSPNode,P_CheckSight,P_InitPicAnims,getSide,getSector,twoSided,getNextSector,P_FindLowestFloorSurrounding,P_FindHighestFloorSurrounding,P_FindNextHighestFloor,P_FindLowestCeilingSurrounding,P_FindHighestCeilingSurrounding,P_FindSectorFromLineTag,P_FindMinSurroundingLight," +
  "P_CrossSpecialLine,P_ShootSpecialLine,P_PlayerInSpecialSector,P_UpdateSpecials,EV_DoDonut,P_SpawnSpecials,P_InitSwitchList,P_StartButton,P_ChangeSwitchTexture,P_UseSpecialLine,EV_Teleport,P_InitThinkers,P_AddThinker,P_RemoveThinker,P_RunThinkers,P_Ticker,P_Thrust,P_CalcHeight,P_MovePlayer,P_DeathThink,P_PlayerThink,R_ClearDrawSegs,R_ClipSolidWallSegment,R_ClipPassWallSegment,R_ClearClipSegs," +
  "R_AddLine,R_CheckBBox,R_Subsector,R_RenderBSPNode,R_DrawColumnInCache,R_GenerateComposite,R_GenerateLookup,R_GetColumn,R_InitTextures,R_InitFlats,R_InitSpriteLumps,R_InitColormaps,R_InitData,R_FlatNumForName,R_CheckTextureNumForName,R_TextureNumForName,R_PrecacheLevel,R_DrawColumn,R_DrawColumnLow,R_DrawFuzzColumn,R_DrawTranslatedColumn,R_InitTranslationTables,R_DrawSpan,R_DrawSpanLow,R_InitBuffer," +
  "R_FillBackScreen,R_VideoErase,R_DrawViewBorder,R_PointOnSide,R_PointOnSegSide,R_PointToAngle,R_PointToAngle2,R_PointToDist,R_ScaleFromGlobalAngle,R_InitTextureMapping,R_InitLightTables,R_SetViewSize,R_ExecuteSetViewSize,R_Init,R_PointInSubsector,R_SetupFrame,R_RenderPlayerView,R_InitPlanes,R_MapPlane,R_ClearPlanes,R_FindPlane,R_CheckPlane,R_MakeSpans,R_DrawPlanes,R_RenderMaskedSegRange," +
  "R_RenderSegLoop,R_StoreWallRange,R_InitSkyMap,R_InstallSpriteLump,R_InitSpriteDefs,R_InitSprites,R_ClearSprites,R_DrawMaskedColumn,R_DrawVisSprite,R_ProjectSprite,R_AddSprites,R_DrawPSprite,R_DrawPlayerSprites,R_SortVisSprites,R_DrawSprite,R_DrawMasked,S_Init,S_SetSfxVolume,S_SetMusicVolume,S_Start,S_StopChannel,S_ChangeMusic,S_StopMusic,S_StartSoundAtVolume,S_AdjustSoundParams," +
  "S_StopSound,S_getChannel,S_StartSound,S_PauseSound,S_ResumeSound,S_UpdateSounds,S_StartMusic,STlib_init,STlib_initNum,STlib_drawNum,STlib_updateNum,STlib_initPercent,STlib_updatePercent,STlib_initMultIcon,STlib_updateMultIcon,STlib_initBinIcon,STlib_updateBinIcon,ST_refreshBackground,ST_Responder,ST_calcPainOffset,ST_updateFaceWidget,ST_updateWidgets,ST_Ticker,ST_doPaletteStuff,ST_drawWidgets," +
  "ST_doRefresh,ST_diffDraw,ST_Drawer,ST_loadGraphics,ST_loadData,ST_initData,ST_createWidgets,ST_Start,ST_Stop,ST_Init,SlopeDiv,memcpy,memset,strlen,strcpy,strncpy,strcat,strcmp,toupper,strcasecmp,strncasecmp,atoi,malloc,realloc,calloc," +
  "open,close,access,read,write,ts_lseek,sprintf,fmt_core,fmt_num,dbg_ptr,fopen,fclose,fprintf,dbg_put,printf,puts,putchar,fwrite,fread,fscanf,getenv,exit,entry,fseek,ftell," +
  "setbuf,mkdir,getchar,fputc,fflush,feof,fstat,sscanf,vfprintf,usleep,I_ReadScreen,ts_memset,ts_memcpy,ts_tick,FixedDiv2,ts_in_wad,V_MarkRect,V_CopyRect,V_DrawPatch,V_DrawPatchFlipped,V_DrawPatchDirect,V_DrawBlock,V_Init,strupr,filelength," +
  "ExtractFileBase,W_AddFile,W_Reload,W_InitMultipleFiles,W_CheckNumForName,W_GetNumForName,W_LumpLength,W_ReadLump,W_CacheLumpNum,W_CacheLumpName,WI_slamBackground,WI_drawLF,WI_drawEL,WI_drawOnLnode,WI_initAnimatedBack,WI_updateAnimatedBack,WI_drawNum,WI_drawPercent,WI_drawTime,WI_unloadData,WI_updateNoState,WI_initShowNextLoc,WI_updateShowNextLoc,WI_drawShowNextLoc,WI_drawNoState," +
  "WI_fragSum,WI_initDeathmatchStats,WI_updateDeathmatchStats,WI_drawDeathmatchStats,WI_initNetgameStats,WI_updateNetgameStats,WI_drawNetgameStats,WI_initStats,WI_updateStats,WI_drawStats,WI_checkForAccelerate,WI_Ticker,WI_loadData,WI_Drawer,WI_initVariables,WI_Start,Z_Init,Z_Free,Z_Malloc,Z_FreeTags,Z_CheckHeap,Z_ChangeTag2"
).split(",");

export interface CfgEntry {
  name: string;
  pos: number;
  end: number;
  line: number;
  endLine: number;
}

export interface CfgSlide {
  block: string;
  fnId: number;
  fnName: string;
  declName: string;
  startLine: number;
  endLine: number;
  code: string;
}

export interface CheckpointInspection {
  headBlock: string;
  fnId: number;
  fnName: string;
  stack: { block: string; fnId: number; fnName: string }[];
  globals: { name: string; u32: number; i32: number; hex: string }[];
  locals: { name: string; u32: number; i32: number; hex: string }[];
  slides: CfgSlide[];
}

export interface Shape {
  bits: number;
  digitBits: number;
  initial: string;
  initialWords?: Uint32Array;
  moduleText?: string;
  cfgEntries?: CfgEntry[];
  cfgByName?: Map<string, number>;
}

export const decodeTrieToU32 = (source: string, bits: number, digitBits: number, baseWords?: Uint32Array): Uint32Array => {
  const fanout = 1 << digitBits;
  const levels = Math.ceil(bits / digitBits);
  const totalWords = Math.pow(fanout, levels);
  const words = baseWords ? baseWords.slice() : new Uint32Array(totalWords);
  let pos = 0;
  const n = source.length;
  const skipSpace = () => {
    while (pos < n && source.charCodeAt(pos) <= 32) pos++;
  };
  const walk = (depth: number, path: number): void => {
    skipSpace();
    if (pos >= n) return;
    if (source.charCodeAt(pos) === 36) {
      const start = pos;
      while (pos < n) {
        const c = source.charCodeAt(pos);
        if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36) pos++;
        else break;
      }
      const name = source.slice(start, pos);
      if (name === "$Zero") {
        if (baseWords) {
          const span = Math.pow(fanout, levels - depth);
          const base = path * span;
          words.fill(0, base, base + span);
        }
        return;
      }
      if (name === "$Absent" || name === "$InitialMemory") return;
      throw new Error(`unexpected alias ${name} in the state`);
    }
    if (source.charCodeAt(pos) !== 91) throw new Error(`bad trie at ${pos}: ${source.slice(pos, pos + 60)}`);
    pos++;
    skipSpace();
    const q = source.charCodeAt(pos);
    if (q === 39 || q === 34) {
      const end = source.indexOf(source[pos]!, pos + 1);
      const text = source.slice(pos + 1, end);
      if (text !== "u") {
        const val = Number.parseInt(text, 2) >>> 0;
        if (depth === levels) {
          words[path] = val;
        } else {
          const span = Math.pow(fanout, levels - depth);
          const base = path * span;
          words.fill(val, base, base + span);
        }
      }
      pos = end + 1;
      skipSpace();
      if (source.charCodeAt(pos) === 93) pos++;
      return;
    }
    for (let child = 0; child < fanout; child++) {
      walk(depth + 1, path * fanout + child);
      skipSpace();
      if (source.charCodeAt(pos) === 44) pos++;
      skipSpace();
      if (source.charCodeAt(pos) === 93) break;
    }
    skipSpace();
    if (source.charCodeAt(pos) === 93) pos++;
  };
  walk(0, 0);
  return words;
};

/// The trie shape and `$InitialMemory` come off the module, as in render-frame.ts:
/// a stale copy decodes into garbage rather than failing.
export const moduleShape = (moduleText: string): Shape => {
  const kidStart = moduleText.indexOf("type $Kid0<");
  const kidRegion = kidStart >= 0 ? moduleText.slice(kidStart, kidStart + 65536) : moduleText;
  const fanout = (kidRegion.match(/type \$Kid\d+</g) ?? []).length;
  const sliceIdx = moduleText.indexOf("type $Slice<");
  const slice = /type \$Slice<A extends string> =[\s\S]*?\n\s*\?\s*`([^`]*)`/.exec(
    sliceIdx >= 0 ? moduleText.slice(sliceIdx, sliceIdx + 2048) : moduleText,
  );
  const initIdx = moduleText.indexOf("export type $InitialMemory");
  const initEq = initIdx >= 0 ? moduleText.indexOf("[", initIdx) : -1;
  let initEnd = initEq >= 0 ? moduleText.indexOf("\nexport type ", initEq) : -1;
  if (initEnd < 0 && initEq >= 0) initEnd = moduleText.indexOf("\n", initEq);
  if (!fanout || !slice || initEq < 0 || initEnd < 0) throw new Error("module has no $Kid/$Slice/$InitialMemory");
  if (moduleText[initEnd - 1] === ";") initEnd--;
  const bits = (slice[1]!.match(/\$\{/g) ?? []).length;
  const digitBits = Math.log2(fanout);
  const initialText = moduleText.slice(initEq, initEnd).trim();
  const initialWords = decodeTrieToU32(initialText, bits, digitBits);
  const cfgStart = moduleText.indexOf("export type $b0_0<", kidStart >= 0 ? kidStart : 0);
  const cfgEntries: CfgEntry[] = [];
  const cfgByName = new Map<string, number>();
  if (cfgStart >= 0) {
    let baseLine = 1;
    for (let i = 0; i < cfgStart; i++) {
      if (moduleText.charCodeAt(i) === 10) baseLine++;
    }
    let pos = cfgStart;
    let line = baseLine;
    while (pos < moduleText.length) {
      const nl = moduleText.indexOf("\n", pos);
      const end = nl === -1 ? moduleText.length : nl;
      if (moduleText.startsWith("export type $", pos)) {
        const lt = moduleText.indexOf("<", pos + 13);
        const eq = moduleText.indexOf("=", pos + 13);
        const nameEnd = lt !== -1 && (eq === -1 || lt < eq) ? lt : eq !== -1 ? eq : end;
        const name = moduleText.slice(pos + 12, nameEnd).trim();
        if (cfgEntries.length > 0) {
          cfgEntries[cfgEntries.length - 1].end = pos;
          cfgEntries[cfgEntries.length - 1].endLine = Math.max(cfgEntries[cfgEntries.length - 1].line, line - 1);
        }
        const idx = cfgEntries.length;
        cfgEntries.push({ name, pos, end: moduleText.length, line, endLine: line });
        cfgByName.set(name, idx);
      }
      if (nl === -1) break;
      pos = nl + 1;
      line++;
    }
    if (cfgEntries.length > 0) cfgEntries[cfgEntries.length - 1].endLine = line;
  }

  return {
    bits,
    digitBits,
    initial: initialText,
    initialWords,
    moduleText,
    cfgEntries,
    cfgByName,
  };
};

function parseWordInfo(name: string, bits: string) {
  const clean = bits.replace(/[^01]/g, "");
  const u32 = Number.parseInt(clean, 2) >>> 0;
  const i32 = u32 | 0;
  const hex = "0x" + u32.toString(16);
  return { name, u32, i32, hex };
}

function annotateCfgSnippet(raw: string): string {
  return raw
    .replace(/\$call(\d+)\b/g, (m, id) => {
      const fn = DOOM_FN_NAMES[Number(id)];
      return fn ? `${m}/*${fn}*/` : m;
    })
    .replace(/\$b(\d+)_(\d+)\b/g, (m, fn) => {
      const name = DOOM_FN_NAMES[Number(fn)];
      return name ? `${m}/*${name}*/` : m;
    })
    .replace(/'([01]{32})'/g, (_m, bits: string) => {
      const u = Number.parseInt(bits, 2) >>> 0;
      if (u === 0) return "'0..0'/*0*/";
      const s = u | 0;
      const hex = "0x" + u.toString(16);
      const comment = s < 0 && s >= -65536 ? String(s) : u >= 1024 ? hex : String(s);
      return `'${bits.slice(0, 6)}..${bits.slice(-6)}'/*${comment}*/`;
    });
}

const PIPELINE_FALLBACK_BLOCKS = [
  "622_0",
  "158_0",
  "36_0",
  "80_0",
  "465_0",
  "516_0",
  "478_1",
  "523_0",
  "540_6",
  "539_0",
  "33_36",
];

export const inspectCheckpoint = (
  shape: Shape,
  point: {
    call?: string;
    frames?: unknown[];
    globals?: string[];
    done?: boolean;
  },
  maxSlides = 8,
): CheckpointInspection | null => {
  const callStr = point?.call;
  if (!callStr) return null;
  const headM = callStr.match(/^\$Exit<\$b(\d+_\d+)<\$FUEL,\s*\[(.*)\],\s*\$Buf<\$IN>,\s*(.*)>>$/s);
  const headBlock = headM ? headM[1] : "622_0";
  const kContent = headM ? headM[2] : "";
  const restArgs = headM ? headM[3] : "";

  const stack: { block: string; fnId: number; fnName: string }[] = [];
  const pushStack = (b: string) => {
    const clean = b.replace(/^trap_/, "");
    const fnId = Number(clean.split("_")[0]);
    const fnName = DOOM_FN_NAMES[fnId] ?? `fn_${fnId}`;
    stack.push({ block: clean, fnId, fnName });
  };
  pushStack(headBlock);
  for (const m of kContent.matchAll(/\[\s*['"]((?:trap_)?\d+_\d+)['"]/g)) {
    pushStack(m[1]);
  }
  if (stack.length === 1 && Array.isArray(point.frames)) {
    for (const f of point.frames) {
      if (f && typeof f === "object" && "block" in f && typeof f.block === "string") {
        pushStack(f.block.replace(/'/g, ""));
      }
    }
  }

  const argWords = [...restArgs.matchAll(/'([01]{32})'/g)].map((m) => m[1]);
  const globals: { name: string; u32: number; i32: number; hex: string }[] = [];
  if (argWords.length >= 2) {
    globals.push(parseWordInfo("$g0", argWords[0]));
    globals.push(parseWordInfo("$g1", argWords[1]));
  } else if (Array.isArray(point.globals)) {
    point.globals.slice(0, 2).forEach((g, i) => globals.push(parseWordInfo(`$g${i}`, String(g))));
  }
  const locals = argWords.slice(2, 10).map((w, i) => parseWordInfo(`$l${i}`, w));

  const slides: CfgSlide[] = [];
  const { moduleText, cfgEntries, cfgByName } = shape;
  if (moduleText && cfgEntries && cfgByName) {
    const visited = new Set<string>();
    const addSlide = (curBlock: string): string | undefined => {
      if (visited.has(curBlock) || slides.length >= maxSlides) return undefined;
      const bIdx = cfgByName.get("$b" + curBlock);
      if (bIdx === undefined) return undefined;
      visited.add(curBlock);
      const pPrefix = `$p${curBlock}_`;
      let startIdx = bIdx;
      while (startIdx > 0 && cfgEntries[startIdx - 1].name.startsWith(pPrefix)) startIdx--;
      const fnId = Number(curBlock.split("_")[0]);
      const fnName = DOOM_FN_NAMES[fnId] ?? `fn_${fnId}`;
      const first = cfgEntries[startIdx];
      const last = cfgEntries[bIdx];
      const raw = moduleText.slice(first.pos, last.end).trimEnd();
      slides.push({
        block: curBlock,
        fnId,
        fnName,
        declName: startIdx < bIdx ? `${first.name} .. ${last.name}` : last.name,
        startLine: first.line,
        endLine: last.endLine,
        code: annotateCfgSnippet(raw),
      });
      const callMatch = raw.match(/\$call(\d+)</);
      const nextBMatch = [...raw.matchAll(/\$b(\d+_\d+)</g)]
        .map((m) => m[1])
        .find((b) => b !== curBlock && !visited.has(b));
      if (callMatch && !visited.has(`${callMatch[1]}_0`) && cfgByName.has(`$b${callMatch[1]}_0`)) {
        return `${callMatch[1]}_0`;
      }
      if (nextBMatch) return nextBMatch;
      const nextEntry = cfgEntries[bIdx + 1];
      const nextM = nextEntry?.name.match(/^\$[pb](\d+_\d+)/);
      return nextM && Number(nextM[1].split("_")[0]) === fnId ? nextM[1] : undefined;
    };

    const nextFromHead = addSlide(headBlock);
    if (!point?.done && nextFromHead) {
      const next2 = addSlide(nextFromHead);
      if (next2 && stack.length <= 2) addSlide(next2);
    }
    for (const frame of stack.slice(1)) {
      addSlide(frame.block);
    }
    if (!point?.done && nextFromHead && !visited.has(nextFromHead)) {
      let cur: string | undefined = nextFromHead;
      while (cur && slides.length < maxSlides) cur = addSlide(cur);
    }
    for (const fb of PIPELINE_FALLBACK_BLOCKS) {
      if (slides.length >= maxSlides) break;
      addSlide(fb);
    }
  }

  return {
    headBlock: stack[0].block,
    fnId: stack[0].fnId,
    fnName: stack[0].fnName,
    stack,
    globals,
    locals,
    slides,
  };
};

let palette: number | undefined = 203868;

/// RGBA pixels for a canvas. `result` is the binary string `entry` returned:
/// each call allocates its own screen, so that is where this frame was drawn.
export const rgbaFrom = (shape: Shape, memory: string, result?: string) => {
  if (shape.initialWords) {
    const words = decodeTrieToU32(memory, shape.bits, shape.digitBits, shape.initialWords);
    const byteAt = (a: number) => ((words[a >>> 2] ?? 0) >>> ((a & 3) * 8)) & 0xff;
    const matches = (base: number) => PALETTE_SIGNATURE.every((b, i) => byteAt(base + i) === b);
    if (palette === undefined || !matches(palette)) {
      palette = undefined;
      for (let base = 0; base < words.length * 4; base++) {
        if (matches(base)) {
          palette = base;
          break;
        }
      }
      if (palette === undefined) throw new Error("no PLAYPAL in memory");
    }
    const screen = result ? Number.parseInt(result.replace(/[^01]/g, ""), 2) : SCREEN;
    const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
    for (let i = 0; i < WIDTH * HEIGHT; i++) {
      const p = palette + byteAt(screen + i) * 3;
      rgba[i * 4] = byteAt(p);
      rgba[i * 4 + 1] = byteAt(p + 1);
      rgba[i * 4 + 2] = byteAt(p + 2);
      rgba[i * 4 + 3] = 255;
    }
    return rgba;
  }
  const words = decodeTrie(memory, shape.bits, shape.digitBits, shape.initial);
  const byteAt = (a: number) => ((words.get(a >>> 2) ?? 0) >>> ((a & 3) * 8)) & 0xff;
  const matches = (base: number) => PALETTE_SIGNATURE.every((b, i) => byteAt(base + i) === b);
  if (palette === undefined || !matches(palette)) {
    let limit = 0;
    for (const w of words.keys()) if (w > limit) limit = w;
    palette = undefined;
    for (let base = 0; base < limit * 4; base++) if (matches(base)) { palette = base; break; }
    if (palette === undefined) throw new Error("no PLAYPAL in memory");
  }
  const screen = result ? Number.parseInt(result.replace(/[^01]/g, ""), 2) : SCREEN;
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    const p = palette + byteAt(screen + i) * 3;
    rgba[i * 4] = byteAt(p);
    rgba[i * 4 + 1] = byteAt(p + 1);
    rgba[i * 4 + 2] = byteAt(p + 2);
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
};
