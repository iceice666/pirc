import 'dart:io';
import 'dart:typed_data';

/// Reads the SFNT horizontal `trak` and variable-font metrics used by the
/// host-font timeline oracle. This is diagnostic tooling only; product code
/// does not load or depend on host fonts.
class SfntFontTracking {
  SfntFontTracking._({
    required this.unitsPerEm,
    required this.xHeight,
    required this.version,
    required this.format,
    required this.horizontalOffset,
    required this.verticalOffset,
    required List<double> sizes,
    required Map<double, List<int>> tracks,
    required List<SfntVariationAxis> axes,
    required Map<String, List<_AvarPoint>> avarMappings,
    required this._mvarStore,
  }) : sizes = List.unmodifiable(sizes),
       _tracks = Map.unmodifiable(tracks),
       axes = List.unmodifiable(axes),
       _avarMappings = Map.unmodifiable(avarMappings);

  final int unitsPerEm;

  /// Default OS/2.sxHeight in font units (before MVAR variation deltas).
  final int? xHeight;
  final int version;
  final int format;
  final int horizontalOffset;
  final int verticalOffset;
  final List<double> sizes;
  final Map<double, List<int>> _tracks;
  final List<SfntVariationAxis> axes;
  final Map<String, List<_AvarPoint>> _avarMappings;
  final _MvarStore? _mvarStore;

  static Future<SfntFontTracking> readFile(File file) async =>
      parse(await file.readAsBytes());

  static SfntFontTracking parse(Uint8List bytes) {
    final data = ByteData.sublistView(bytes);
    _checkRange(data, 0, 12, 'SFNT header');
    final tableCount = data.getUint16(4, Endian.big);
    _checkRange(data, 12, tableCount * 16, 'SFNT table directory');

    final tables = <String, _Table>{};
    for (var index = 0; index < tableCount; index++) {
      final entry = 12 + index * 16;
      final tag = String.fromCharCodes(bytes.sublist(entry, entry + 4));
      final offset = data.getUint32(entry + 8, Endian.big);
      final length = data.getUint32(entry + 12, Endian.big);
      _checkRange(data, offset, length, 'SFNT $tag table');
      tables[tag] = _Table(offset, length);
    }

    final head = tables['head'];
    if (head == null || head.length < 20) {
      throw const FormatException('SFNT has no valid head table');
    }
    final unitsPerEm = data.getUint16(head.offset + 18, Endian.big);
    if (unitsPerEm == 0) {
      throw const FormatException('SFNT head.unitsPerEm cannot be zero');
    }

    int? xHeight;
    final os2 = tables['OS/2'];
    if (os2 != null && os2.length >= 88) {
      final os2Version = data.getUint16(os2.offset, Endian.big);
      if (os2Version >= 2) {
        final candidate = data.getInt16(os2.offset + 86, Endian.big);
        if (candidate > 0) xHeight = candidate;
      }
    }

    final axes = _parseFvar(data, tables['fvar']);
    final avar = _parseAvar(data, tables['avar'], axes);
    final mvar = _parseMvar(data, tables['MVAR']);

    final trak = tables['trak'];
    if (trak == null || trak.length < 12) {
      throw const FormatException('SFNT trak table is missing or invalid');
    }
    final version = data.getUint32(trak.offset, Endian.big);
    final format = data.getUint16(trak.offset + 4, Endian.big);
    final horizontalOffset = data.getUint16(trak.offset + 6, Endian.big);
    final verticalOffset = data.getUint16(trak.offset + 8, Endian.big);
    if (horizontalOffset == 0) {
      throw const FormatException('SFNT trak has no horizontal TrackData');
    }
    final trackDataOffset = horizontalOffset;
    _checkTableRange(
      trackDataOffset,
      8,
      trak.length,
      'trak horizontal TrackData header',
    );
    final trackData = trak.offset + trackDataOffset;
    final trackCount = data.getUint16(trackData, Endian.big);
    final sizeCount = data.getUint16(trackData + 2, Endian.big);
    final sizeTableOffset = data.getUint32(trackData + 4, Endian.big);
    _checkTableRange(
      trackDataOffset + 8,
      trackCount * 8,
      trak.length,
      'trak track records',
    );
    _checkTableRange(
      sizeTableOffset,
      sizeCount * 4,
      trak.length,
      'trak point-size table',
    );

    final sizes = <double>[
      for (var index = 0; index < sizeCount; index++)
        data.getInt32(trak.offset + sizeTableOffset + index * 4, Endian.big) /
            65536,
    ];
    if (sizes.isEmpty || sizes.any((size) => !size.isFinite)) {
      throw const FormatException(
        'SFNT trak point-size table is empty or invalid',
      );
    }
    for (var index = 1; index < sizes.length; index++) {
      if (sizes[index] <= sizes[index - 1]) {
        throw const FormatException('SFNT trak point sizes must be increasing');
      }
    }

    final tracks = <double, List<int>>{};
    for (var index = 0; index < trackCount; index++) {
      final entry = trackData + 8 + index * 8;
      final track = data.getInt32(entry, Endian.big) / 65536;
      final valuesOffset = data.getUint16(entry + 6, Endian.big);
      _checkTableRange(
        valuesOffset,
        sizeCount * 2,
        trak.length,
        'trak adjustments for track $track',
      );
      tracks[track] = [
        for (var sizeIndex = 0; sizeIndex < sizeCount; sizeIndex++)
          data.getInt16(trak.offset + valuesOffset + sizeIndex * 2, Endian.big),
      ];
    }
    if (!tracks.containsKey(0)) {
      throw const FormatException(
        'SFNT trak has no normal (track 0) adjustment',
      );
    }

    return SfntFontTracking._(
      unitsPerEm: unitsPerEm,
      xHeight: xHeight,
      version: version,
      format: format,
      horizontalOffset: horizontalOffset,
      verticalOffset: verticalOffset,
      sizes: sizes,
      tracks: tracks,
      axes: axes,
      avarMappings: avar,
      mvarStore: mvar,
    );
  }

  /// Returns the normal/horizontal trak adjustment in font units.
  double adjustmentAt(double pointSize, {double track = 0}) {
    if (!pointSize.isFinite || pointSize <= 0) {
      throw ArgumentError.value(pointSize, 'pointSize', 'must be positive');
    }
    final values = _tracks[track];
    if (values == null) {
      throw ArgumentError.value(track, 'track', 'not present in SFNT trak');
    }
    if (pointSize <= sizes.first) return values.first.toDouble();
    if (pointSize >= sizes.last) return values.last.toDouble();
    for (var index = 0; index < sizes.length - 1; index++) {
      final left = sizes[index];
      final right = sizes[index + 1];
      if (pointSize == left) return values[index].toDouble();
      if (pointSize <= right) {
        final fraction = (pointSize - left) / (right - left);
        return values[index] + (values[index + 1] - values[index]) * fraction;
      }
    }
    return values.last.toDouble();
  }

  /// Returns letter spacing in logical pixels for a CSS/Flutter point size.
  double letterSpacing(double pointSize, {double track = 0}) =>
      pointSize * adjustmentAt(pointSize, track: track) / unitsPerEm;

  /// Evaluates MVAR `xhgt` at the requested design-axis coordinates.
  /// Unspecified axes use their fvar defaults. Axis values are clamped to the
  /// font's min/max, normalized around the default, then passed through avar.
  SfntFontXHeightSample sampleXHeightAt(Map<String, double> designCoordinates) {
    final base = xHeight;
    if (base == null) {
      throw const FormatException('SFNT has no OS/2.sxHeight metric');
    }
    final normalized = <String, double>{};
    final actual = <String, double>{};
    for (final axis in axes) {
      final requested = designCoordinates[axis.tag] ?? axis.defaultValue;
      if (!requested.isFinite) {
        throw ArgumentError.value(requested, axis.tag, 'must be finite');
      }
      final clamped = requested.clamp(axis.minimum, axis.maximum).toDouble();
      actual[axis.tag] = clamped;
      var coordinate = axis.normalize(clamped);
      final mapping = _avarMappings[axis.tag];
      if (mapping != null && mapping.isNotEmpty) {
        coordinate = _mapAvar(coordinate, mapping);
      }
      normalized[axis.tag] = coordinate;
    }
    final delta =
        _mvarStore?.delta('xhgt', axes.length, normalized.values.toList()) ??
        0.0;
    return SfntFontXHeightSample(
      baseUnits: base,
      deltaUnits: delta,
      variedUnits: base + delta,
      designCoordinates: actual,
      normalizedCoordinates: normalized,
      mvarValueRecord: _mvarStore?.recordFor('xhgt'),
    );
  }

  static List<SfntVariationAxis> _parseFvar(ByteData data, _Table? table) {
    if (table == null) return const [];
    if (table.length < 16) {
      throw const FormatException('SFNT fvar table is truncated');
    }
    final offset = table.offset;
    final major = data.getUint16(offset, Endian.big);
    if (major != 1) {
      throw FormatException('Unsupported fvar major version $major');
    }
    final axesOffset = data.getUint16(offset + 4, Endian.big);
    final axisCount = data.getUint16(offset + 8, Endian.big);
    final axisSize = data.getUint16(offset + 10, Endian.big);
    if (axisSize < 20) {
      throw const FormatException('SFNT fvar axis record is too small');
    }
    _checkTableRange(
      axesOffset,
      axisCount * axisSize,
      table.length,
      'fvar axes',
    );
    return [
      for (var index = 0; index < axisCount; index++)
        () {
          final record = offset + axesOffset + index * axisSize;
          final tag = String.fromCharCodes(data.buffer.asUint8List(record, 4));
          final minimum = data.getInt32(record + 4, Endian.big) / 65536;
          final defaultValue = data.getInt32(record + 8, Endian.big) / 65536;
          final maximum = data.getInt32(record + 12, Endian.big) / 65536;
          if (!(minimum <= defaultValue && defaultValue <= maximum)) {
            throw FormatException('Invalid fvar axis bounds for $tag');
          }
          return SfntVariationAxis(
            tag: tag,
            minimum: minimum,
            defaultValue: defaultValue,
            maximum: maximum,
          );
        }(),
    ];
  }

  static Map<String, List<_AvarPoint>> _parseAvar(
    ByteData data,
    _Table? table,
    List<SfntVariationAxis> axes,
  ) {
    if (table == null) return const {};
    if (table.length < 8) {
      throw const FormatException('SFNT avar table is truncated');
    }
    final offset = table.offset;
    final major = data.getUint16(offset, Endian.big);
    if (major != 1) {
      throw FormatException('Unsupported avar major version $major');
    }
    final axisCount = data.getUint16(offset + 6, Endian.big);
    if (axisCount != axes.length) {
      throw FormatException(
        'SFNT avar axis count $axisCount != fvar ${axes.length}',
      );
    }
    var cursor = 8;
    final result = <String, List<_AvarPoint>>{};
    for (final axis in axes) {
      _checkTableRange(cursor, 2, table.length, 'avar segment-map count');
      final pairCount = data.getUint16(offset + cursor, Endian.big);
      cursor += 2;
      _checkTableRange(
        cursor,
        pairCount * 4,
        table.length,
        'avar segment maps',
      );
      final points = <_AvarPoint>[];
      for (var pair = 0; pair < pairCount; pair++) {
        points.add(
          _AvarPoint(
            data.getInt16(offset + cursor, Endian.big) / 16384,
            data.getInt16(offset + cursor + 2, Endian.big) / 16384,
          ),
        );
        cursor += 4;
      }
      result[axis.tag] = points;
    }
    return result;
  }

  static _MvarStore? _parseMvar(ByteData data, _Table? table) {
    if (table == null) return null;
    if (table.length < 12) {
      throw const FormatException('SFNT MVAR table is truncated');
    }
    final offset = table.offset;
    final major = data.getUint16(offset, Endian.big);
    if (major != 1) {
      throw FormatException('Unsupported MVAR major version $major');
    }
    final recordSize = data.getUint16(offset + 6, Endian.big);
    final recordCount = data.getUint16(offset + 8, Endian.big);
    final storeOffset = data.getUint16(offset + 10, Endian.big);
    if (recordSize < 8) {
      throw const FormatException('SFNT MVAR value record is too small');
    }
    _checkTableRange(
      12,
      recordCount * recordSize,
      table.length,
      'MVAR value records',
    );
    final records = <String, _MvarRecord>{};
    for (var index = 0; index < recordCount; index++) {
      final record = offset + 12 + index * recordSize;
      final tag = String.fromCharCodes(data.buffer.asUint8List(record, 4));
      records[tag] = _MvarRecord(
        data.getUint16(record + 4, Endian.big),
        data.getUint16(record + 6, Endian.big),
      );
    }
    if (storeOffset == 0) {
      return _MvarStore(records: records, regions: const [], data: const []);
    }
    _checkTableRange(storeOffset, 8, table.length, 'MVAR item variation store');
    final store = offset + storeOffset;
    final format = data.getUint16(store, Endian.big);
    if (format != 1) {
      throw FormatException('Unsupported MVAR store format $format');
    }
    final regionListOffset = data.getUint32(store + 2, Endian.big);
    final dataCount = data.getUint16(store + 6, Endian.big);
    _checkTableRange(
      8,
      dataCount * 4,
      table.length,
      'MVAR variation data offsets',
    );
    final dataOffsets = [
      for (var index = 0; index < dataCount; index++)
        data.getUint32(store + 8 + index * 4, Endian.big),
    ];

    _checkTableRange(
      storeOffset + regionListOffset,
      4,
      table.length,
      'MVAR region list',
    );
    final regionList = store + regionListOffset;
    final axisCount = data.getUint16(regionList, Endian.big);
    final regionCount = data.getUint16(regionList + 2, Endian.big);
    final regionBytes = axisCount * regionCount * 6;
    _checkTableRange(
      regionListOffset + 4,
      regionBytes,
      table.length,
      'MVAR regions',
    );
    var regionCursor = regionList + 4;
    final regions = <List<_RegionAxis>>[];
    for (var region = 0; region < regionCount; region++) {
      final axisRegions = <_RegionAxis>[];
      for (var axis = 0; axis < axisCount; axis++) {
        axisRegions.add(
          _RegionAxis(
            data.getInt16(regionCursor, Endian.big) / 16384,
            data.getInt16(regionCursor + 2, Endian.big) / 16384,
            data.getInt16(regionCursor + 4, Endian.big) / 16384,
          ),
        );
        regionCursor += 6;
      }
      regions.add(axisRegions);
    }

    final variationData = <_ItemVariationData>[];
    for (var index = 0; index < dataOffsets.length; index++) {
      final dataOffset = dataOffsets[index];
      _checkTableRange(
        storeOffset + dataOffset,
        6,
        table.length,
        'MVAR variation item data',
      );
      final itemData = store + dataOffset;
      final itemCount = data.getUint16(itemData, Endian.big);
      final wordDeltaCountWithFlag = data.getUint16(itemData + 2, Endian.big);
      final longWords = (wordDeltaCountWithFlag & 0x8000) != 0;
      final wordDeltaCount = wordDeltaCountWithFlag & 0x7fff;
      final regionIndexCount = data.getUint16(itemData + 4, Endian.big);
      if (wordDeltaCount > regionIndexCount) {
        throw const FormatException(
          'MVAR word delta count exceeds region index count',
        );
      }
      final regionIndexesBytes = regionIndexCount * 2;
      _checkTableRange(
        dataOffset + 6,
        regionIndexesBytes,
        table.length,
        'MVAR region indexes',
      );
      final regionIndexes = [
        for (var item = 0; item < regionIndexCount; item++)
          data.getUint16(itemData + 6 + item * 2, Endian.big),
      ];
      if (regionIndexes.any((regionIndex) => regionIndex >= regions.length)) {
        throw const FormatException('MVAR region index is out of range');
      }
      var deltaCursor = itemData + 6 + regionIndexesBytes;
      final rows = <List<int>>[];
      for (var item = 0; item < itemCount; item++) {
        final row = <int>[];
        for (var deltaIndex = 0; deltaIndex < regionIndexCount; deltaIndex++) {
          if (deltaIndex < wordDeltaCount) {
            if (longWords) {
              _checkRange(data, deltaCursor, 4, 'MVAR int32 delta');
              row.add(data.getInt32(deltaCursor, Endian.big));
              deltaCursor += 4;
            } else {
              _checkRange(data, deltaCursor, 2, 'MVAR int16 delta');
              row.add(data.getInt16(deltaCursor, Endian.big));
              deltaCursor += 2;
            }
          } else if (longWords) {
            _checkRange(data, deltaCursor, 2, 'MVAR int16 delta');
            row.add(data.getInt16(deltaCursor, Endian.big));
            deltaCursor += 2;
          } else {
            _checkRange(data, deltaCursor, 1, 'MVAR int8 delta');
            row.add(data.getInt8(deltaCursor));
            deltaCursor += 1;
          }
        }
        rows.add(row);
      }
      variationData.add(_ItemVariationData(regionIndexes, rows));
    }
    return _MvarStore(records: records, regions: regions, data: variationData);
  }

  static double _mapAvar(double value, List<_AvarPoint> points) {
    if (points.isEmpty) return value;
    if (value <= points.first.from) return points.first.to;
    if (value >= points.last.from) return points.last.to;
    for (var index = 0; index < points.length - 1; index++) {
      final left = points[index];
      final right = points[index + 1];
      if (value == left.from) return left.to;
      if (value <= right.from) {
        final fraction = (value - left.from) / (right.from - left.from);
        return left.to + (right.to - left.to) * fraction;
      }
    }
    return points.last.to;
  }

  static void _checkRange(
    ByteData data,
    int offset,
    int length,
    String description,
  ) {
    if (offset < 0 || length < 0 || offset + length > data.lengthInBytes) {
      throw FormatException('Out-of-range $description at $offset+$length');
    }
  }

  static void _checkTableRange(
    int offset,
    int length,
    int tableLength,
    String description,
  ) {
    if (offset < 0 || length < 0 || offset + length > tableLength) {
      throw FormatException('Out-of-range $description at $offset+$length');
    }
  }
}

class SfntVariationAxis {
  const SfntVariationAxis({
    required this.tag,
    required this.minimum,
    required this.defaultValue,
    required this.maximum,
  });
  final String tag;
  final double minimum, defaultValue, maximum;

  double normalize(double value) {
    if (value == defaultValue) return 0;
    if (value < defaultValue) {
      if (minimum == defaultValue) return -1;
      return (value - defaultValue) / (defaultValue - minimum);
    }
    if (maximum == defaultValue) return 1;
    return (value - defaultValue) / (maximum - defaultValue);
  }
}

class SfntFontXHeightSample {
  const SfntFontXHeightSample({
    required this.baseUnits,
    required this.deltaUnits,
    required this.variedUnits,
    required this.designCoordinates,
    required this.normalizedCoordinates,
    required this.mvarValueRecord,
  });
  final int baseUnits;
  final double deltaUnits, variedUnits;
  final Map<String, double> designCoordinates;
  final Map<String, double> normalizedCoordinates;
  final Map<String, int>? mvarValueRecord;

  Map<String, Object?> toJson({
    required int unitsPerEm,
    required double pxSize,
  }) => {
    'baseUnits': baseUnits,
    'mvarDeltaUnits': deltaUnits,
    'variedUnits': variedUnits,
    'unitsPerEm': unitsPerEm,
    'designCoordinates': designCoordinates,
    'normalizedCoordinates': normalizedCoordinates,
    'mvarValueRecord': mvarValueRecord,
    'xHeightPxAtSize': variedUnits / unitsPerEm * pxSize,
    'ex4PxAtSize': variedUnits / unitsPerEm * pxSize * 4,
  };
}

class _Table {
  const _Table(this.offset, this.length);
  final int offset, length;
}

class _AvarPoint {
  const _AvarPoint(this.from, this.to);
  final double from, to;
}

class _RegionAxis {
  const _RegionAxis(this.start, this.peak, this.end);
  final double start, peak, end;

  double scalar(double coordinate) {
    if (peak == 0) return 1;
    if (coordinate < start || coordinate > end) return 0;
    if (coordinate == peak) return 1;
    if (coordinate < peak) {
      if (peak == start) return 0;
      return (coordinate - start) / (peak - start);
    }
    if (end == peak) return 0;
    return (end - coordinate) / (end - peak);
  }
}

class _MvarRecord {
  const _MvarRecord(this.outerIndex, this.innerIndex);
  final int outerIndex, innerIndex;
}

class _ItemVariationData {
  const _ItemVariationData(this.regionIndexes, this.rows);
  final List<int> regionIndexes;
  final List<List<int>> rows;
}

class _MvarStore {
  const _MvarStore({
    required this.records,
    required this.regions,
    required this.data,
  });
  final Map<String, _MvarRecord> records;
  final List<List<_RegionAxis>> regions;
  final List<_ItemVariationData> data;

  Map<String, int>? recordFor(String tag) {
    final record = records[tag];
    return record == null
        ? null
        : {'outerIndex': record.outerIndex, 'innerIndex': record.innerIndex};
  }

  double delta(String tag, int axisCount, List<double> normalized) {
    final record = records[tag];
    if (record == null) return 0;
    if (record.outerIndex >= data.length) {
      throw FormatException('MVAR $tag outer index is out of range');
    }
    final itemData = data[record.outerIndex];
    if (record.innerIndex >= itemData.rows.length) {
      throw FormatException('MVAR $tag inner index is out of range');
    }
    final row = itemData.rows[record.innerIndex];
    var result = 0.0;
    for (var index = 0; index < row.length; index++) {
      final region = regions[itemData.regionIndexes[index]];
      if (region.length != axisCount) {
        throw FormatException(
          'MVAR $tag region axis count does not match fvar',
        );
      }
      var scalar = 1.0;
      for (var axisIndex = 0; axisIndex < region.length; axisIndex++) {
        final axis = region[axisIndex];
        scalar *= axis.scalar(
          axisIndex < normalized.length ? normalized[axisIndex] : 0,
        );
      }
      result += row[index] * scalar;
    }
    return result;
  }
}
