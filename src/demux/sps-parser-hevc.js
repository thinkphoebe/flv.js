class HEVCSpsParser {
    constructor(data) {
        this.data = data;
        // the number of bytes left to examine in this.data
        this.bytesAvailable = this.data.byteLength;
        // the number of bits left to examine in the current word
        this.bitsAvailable = 0; // :uint
        this.firstByte = 0xff;
        this.cache = 0xff;
        this.bitsInCache = 0;
    }

    getByte() {
        let position = this.data.byteLength - this.bytesAvailable,
            availableBytes = Math.min(1, this.bytesAvailable);

        let byte = new Uint8Array(1);
        byte.set(this.data.subarray(position, position + availableBytes));
        this.bitsAvailable = availableBytes * 8;
        this.bytesAvailable -= availableBytes;

        let byteAsUint8 = new DataView(byte.buffer).getUint8(0);
        return byteAsUint8;
    }

    // (size:int):uint
    read(nbits) {
        while (this.bitsInCache < nbits) {
            let checkThreeByte = true;
            let byte = this.getByte();

            if (checkThreeByte && byte === 0x03 && this.firstByte === 0x00
                && (this.cache & 0xff) === 0) {
                byte = this.getByte();
                checkThreeByte = false;
            }
            this.cache = (this.cache << 8) | this.firstByte;
            this.firstByte = byte;
            this.bitsInCache += 8;
        }
    }


    // (size:int):void
    skipBits(nbits) {
        this.read(nbits);
        this.bitsInCache = this.bitsInCache - nbits;
    }

    // (size:int):uint
    readBits(nbits) {
        this.read(nbits);
        let shift = this.bitsInCache - nbits;
        let val = this.firstByte >> shift;
        val |= (this.cache << (8 - shift)); 

        val &= ((1 << nbits) - 1);
        this.bitsInCache = shift;
        return val;
    }

    // ():uint
    readUE() {
        let val = 0x00;
        let i = 0;
        let bit;
        bit = this.readBits(1);
        while (bit === 0) {
            i++;
            bit = this.readBits(1);
        }

        val = this.readBits(i);
        return (1 << i) - 1 + val;
    }

    readProfileTierLevel(maxSubLayersMinus1) {
        let profileSpace = this.readBits(2);
        let tierFlag = this.readBits(1);
        let profileIdc = this.readBits(5);
        let profileCompatibilityFlags = this.readBits(8) | (this.readBits(8) << 8) | (this.readBits(8) << 16) | (this.readBits(8) << 24);

        let constraintFlags = new Uint8Array(6);
        for (let i = 0; i < 6; i++) {
            constraintFlags[i] = this.readBits(8);
        }

        let levelIdc = this.readBits(8);

        let subLayerProfilePresentFlag = [];
        let subLayerLevelPresentFlag = [];
        for (let j = 0; j < maxSubLayersMinus1; j++) {
            subLayerProfilePresentFlag[j] = this.readBits(1);
            subLayerLevelPresentFlag[j] = this.readBits(1);
        }

        if (maxSubLayersMinus1 !== 0) {
            this.skipBits((8 - maxSubLayersMinus1) * 2);
        }

        for (let i = 0; i < maxSubLayersMinus1; i++) {
            if (subLayerProfilePresentFlag[i] !== 0) {
                this.skipBits(2);
                this.skipBits(1);
                this.skipBits(5);

                this.skipBits(16);
                this.skipBits(16);

                this.skipBits(4);

                this.skipBits(16);
                this.skipBits(16);
                this.skipBits(12);
            }
            if (subLayerLevelPresentFlag[i] !== 0) {
                this.skipBits(8);
            }
        }

        // ================ generate codecId for MSE ================
        // 'hev1.' or 'hvc1.' prefix (5 chars)
        let codecId = 'hvc1.';

        // profile, e.g. '.A12' (max 4 chars)
        if (profileSpace > 0 && profileSpace <= 3) {
            const chr = ['A', 'B', 'C'];
            codecId += chr[profileSpace - 1];
        }
        codecId += profileIdc.toString(10);

        // profile_compatibility, dot + 32-bit hex number (max 9 chars)
        codecId += ('.' + profileCompatibilityFlags.toString(16));

        // tier and level, e.g. '.H120' (max 5 chars)
        if (tierFlag == 0) {
            codecId += '.L';
        } else {
            codecId += '.H';
        }
        codecId += levelIdc.toString(10);

        // up to 6 constraint bytes, bytes are dot-separated and hex-encoded.
        let found = false;
        let constraintFlagsStr = '';
        for (let i = 5; i >= 0; i--) {
            if (!found && constraintFlags[i] != 0) {
                found = true;
            }
            if (found) {
                constraintFlagsStr = '.' + constraintFlags[i].toString(16) + constraintFlagsStr;
            }
        }
        if (constraintFlagsStr != '') {
            codecId += constraintFlagsStr;
        }

        return codecId;
    }

    static getChromaFormatString(chroma) {
        switch (chroma) {
            case 420:
                return '4:2:0';
            case 422:
                return '4:2:2';
            case 444:
                return '4:4:4';
            default:
                return 'Unknown';
        }
    }

    readSPSHEVC() {
        let
            vpsId = 0,
            maxSubLayersMinus1 = 0,
            tINf = 0,
            spsId = 0,
            chromaFormatIdc = 0,
            width = 0,
            height = 0,
            conformanceWindowFlag = 0,
            bitDepthLuma = 8,
            bitDepthChroma = 8;

        let chroma_format = 420;
        let chroma_format_table = [0, 420, 422, 444];

        this.readBits(8); // NAL header
        this.readBits(8); // NAL header

        vpsId = this.readBits(4); // vps_id
        maxSubLayersMinus1 = this.readBits(3); // max_sub_layers_minus1
        tINf = this.readBits(1); // temporal_id_nesting_flag

        let codecId = this.readProfileTierLevel(maxSubLayersMinus1);

        spsId = this.readUE(); // sps id
        chromaFormatIdc = this.readUE();
        if (chromaFormatIdc === 3) {
            this.skipBits(1); // separate_colour_plane_flag
        }
        if (chromaFormatIdc <= 3) {
            chroma_format = chroma_format_table[chromaFormatIdc];
        }

        width = this.readUE(); // pic_width_in_luma_samples
        height = this.readUE(); // pic_height_in_luma_samples

        conformanceWindowFlag = this.readBits(1);
        if (conformanceWindowFlag === 1) {
            this.readUE(); // conf_win_left_offset
            this.readUE(); // conf_win_right_offset
            this.readUE(); // conf_win_top_offset
            this.readUE(); // conf_win_bottom_offset
        }

        bitDepthLuma = this.readUE() + 8;
        bitDepthChroma = this.readUE() + 8;

        return {codecId: codecId,
            width: width, height: height, 
            chromaFormat: chroma_format, 
            chromaFormatString: HEVCSpsParser.getChromaFormatString(chroma_format), 
            bitDepthLuma: bitDepthLuma, 
            bitDepthChroma: bitDepthChroma};
    }
}

export default HEVCSpsParser;
