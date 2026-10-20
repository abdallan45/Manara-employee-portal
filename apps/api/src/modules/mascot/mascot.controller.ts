import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, Res, UploadedFile, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  MASCOT_AUDIO_MAX_BYTES, MASCOT_AUDIO_MIME, PERMISSIONS, type MascotConfigDto, type MascotLanguage, type MascotGroupDto, type MascotLineDto,
} from '@workforce/shared';
import { CurrentUser, RequirePermissions, type AuthUser } from '../../common/auth';
import { parseRange } from './mascot-audio';
import {
  CreateMascotGroupDto, CreateMascotLineDto, MascotConfigQueryDto, MascotEnabledDto, MascotLanguageDto, UpdateMascotGroupDto, UpdateMascotLineDto,
} from './mascot.dto';
import { MascotService, type UploadedAudio } from './mascot.service';

const MANAGE = PERMISSIONS.MASCOT_MANAGE;

/** True when an If-None-Match header lists this entity tag (or "*"). */
const etagMatches = (header: string | undefined, etag: string) =>
  !!header && header.split(',').map((s) => s.trim().replace(/^W\//, '')).some((t) => t === etag || t === '*');

@ApiTags('Mascot')
@Controller('mascot')
export class MascotController {
  constructor(private readonly mascot: MascotService) {}

  @Get('config')
  @ApiOperation({ summary: 'Nouria content and the on/off switch (active content only; all=true includes inactive, mascot.manage only)' })
  config(@CurrentUser() user: AuthUser, @Query() q: MascotConfigQueryDto): Promise<MascotConfigDto> {
    return this.mascot.config(user, q.all === 'true');
  }

  @Get('lines/:id/audio')
  @ApiProduces(...MASCOT_AUDIO_MIME)
  @ApiOperation({ summary: 'A line\'s recording (versioned URL, cacheable; supports ETag/If-None-Match and single byte ranges)' })
  async audio(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const { data, mime, sha256 } = await this.mascot.audio(user, id);
    const etag = `"${sha256}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (etagMatches(req.get('if-none-match'), etag)) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Type', mime);
    const ifRange = req.get('if-range');
    const range = ifRange && ifRange !== etag ? null : parseRange(req.get('range'), data.length);
    if (range === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${data.length}`);
      res.status(416).end();
      return;
    }
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${data.length}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
      res.end(data.subarray(range.start, range.end + 1));
      return;
    }
    res.setHeader('Content-Length', String(data.length));
    res.end(data);
  }

  @Put('language')
  @RequirePermissions(MANAGE)
  @ApiOperation({ summary: 'Language Nouria speaks for everyone: auto (viewer interface), ar or en (system setting mascot.language; audited)' })
  setLanguage(@CurrentUser() user: AuthUser, @Body() body: MascotLanguageDto): Promise<{ language: MascotLanguage }> {
    return this.mascot.setLanguage(user, body.language);
  }

  @Put('enabled')
  @RequirePermissions(MANAGE)
  @ApiOperation({ summary: 'Turn Nouria on or off for everyone (system setting mascot.enabled; audited)' })
  setEnabled(@CurrentUser() user: AuthUser, @Body() body: MascotEnabledDto): Promise<{ enabled: boolean }> {
    return this.mascot.setEnabled(user, body.enabled);
  }

  @Post('groups')
  @RequirePermissions(MANAGE)
  @ApiOperation({ summary: 'Create a group (trigger, conditions, priority, moods); audited' })
  createGroup(@CurrentUser() user: AuthUser, @Body() body: CreateMascotGroupDto): Promise<MascotGroupDto> {
    return this.mascot.createGroup(user, body);
  }

  @Patch('groups/:id')
  @RequirePermissions(MANAGE)
  @ApiOperation({ summary: 'Update a group (conditions are replaced as a whole); audited' })
  updateGroup(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateMascotGroupDto): Promise<MascotGroupDto> {
    return this.mascot.updateGroup(user, id, body);
  }

  @Delete('groups/:id')
  @HttpCode(204)
  @RequirePermissions(MANAGE)
  @ApiOperation({ summary: 'Delete a group with all its lines and recordings; audited' })
  deleteGroup(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.mascot.deleteGroup(user, id);
  }

  @Post('groups/:id/lines')
  @RequirePermissions(MANAGE)
  @ApiOperation({ summary: 'Add a line to a group; audited' })
  createLine(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: CreateMascotLineDto): Promise<MascotLineDto> {
    return this.mascot.createLine(user, id, body);
  }

  @Patch('lines/:id')
  @RequirePermissions(MANAGE)
  @ApiOperation({ summary: 'Update a line; audited' })
  updateLine(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: UpdateMascotLineDto): Promise<MascotLineDto> {
    return this.mascot.updateLine(user, id, body);
  }

  @Delete('lines/:id')
  @HttpCode(204)
  @RequirePermissions(MANAGE)
  @ApiOperation({ summary: 'Delete a line and its recording; audited' })
  deleteLine(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.mascot.deleteLine(user, id);
  }

  @Put('lines/:id/audio')
  @RequirePermissions(MANAGE)
  // Twice the limit so slightly larger files get the clear answer from the service instead of multer's.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MASCOT_AUDIO_MAX_BYTES * 2, files: 1, fields: 0 } }))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' } } } })
  @ApiOperation({
    summary: `Set or replace a line's recording (${MASCOT_AUDIO_MIME.join(', ')}; max ${MASCOT_AUDIO_MAX_BYTES / 1024 / 1024} MB; content must match the type); audited without the audio`,
  })
  setAudio(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @UploadedFile() file: UploadedAudio | undefined): Promise<MascotLineDto> {
    return this.mascot.setAudio(user, id, file);
  }

  @Delete('lines/:id/audio')
  @RequirePermissions(MANAGE)
  @ApiOperation({ summary: 'Remove a line\'s recording (the line stays, text only); audited' })
  deleteAudio(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<MascotLineDto> {
    return this.mascot.deleteAudio(user, id);
  }
}
